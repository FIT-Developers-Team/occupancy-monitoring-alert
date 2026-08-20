#!/usr/bin/env python3
"""
superset_to_duckdb.py
=====================
Auto Live Sync: Superset data tables -> DuckDB, with historical retention.

Design goals (aligned with FIT stack):
  - Reuse the proven Superset extraction pattern: cookie/JWT auth, CSRF,
    server-side filtering, KEYSET pagination to bypass the row-limit ceiling.
  - Land into DuckDB (embedded, columnar) instead of Sheets, so history can
    grow to millions of rows and be queried analytically.
  - Three sync modes so one engine covers current-state and event tables:
        snapshot    : append a full pull, stamped with _synced_at  -> builds
                      a time series from a "current state" table (e.g. occupancy).
        incremental : watermark-based; pull only rows newer than the last sync.
        upsert      : merge latest state on PK, and keep an append-only history
                      table (SCD-ish) so nothing is ever lost.
  - Concurrency-safe (single-writer DuckDB) via an OS-level lock file.
  - Idempotent, retry-with-backoff, schema-evolution tolerant, audited.

Dependencies: requests, duckdb, pandas
    pip install requests duckdb pandas --break-system-packages

Run one pass:      python superset_to_duckdb.py --config config.json
Run continuously:  python superset_to_duckdb.py --config config.json --loop 300
Run one job:       python superset_to_duckdb.py --config config.json --job occupancy_snapshot
"""

from __future__ import annotations

import argparse
import atexit
import base64
import re
import zlib
from urllib.parse import quote
import json
import logging
import os
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional

import duckdb  # type: ignore

try:
    import pandas as pd  # type: ignore
except ImportError:  # pandas optional at import time; required at run time for real sync
    pd = None

# ----------------------------------------------------------------------------- #
# Logging
# ----------------------------------------------------------------------------- #
log = logging.getLogger("s2duck")
_handler = logging.StreamHandler(sys.stdout)
_handler.setFormatter(logging.Formatter("%(asctime)s  %(levelname)-7s %(message)s", "%H:%M:%S"))
log.addHandler(_handler)
log.setLevel(logging.INFO)


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def decode_flask_session(val: str):
    """Baca cookie session Flask TANPA secret: (payload_dict|None, issued_dt|None, err|None).
    payload None + err = cookie korup/terpotong saat disalin."""
    try:
        parts = val.strip().strip('"').split(".")
        if val.startswith("."):
            raw_p, raw_ts = parts[1], parts[2]
            data = json.loads(zlib.decompress(_b64d(raw_p)))
        else:
            raw_p, raw_ts = parts[0], parts[1]
            data = json.loads(_b64d(raw_p))
        issued = datetime.fromtimestamp(int.from_bytes(_b64d(raw_ts), "big"), tz=timezone.utc)
        return data, issued, None
    except Exception as e:  # noqa: BLE001
        # timestamp kadang masih terbaca meski payload korup
        try:
            issued = datetime.fromtimestamp(
                int.from_bytes(_b64d(val.split(".")[-2]), "big"), tz=timezone.utc)
        except Exception:  # noqa: BLE001
            issued = None
        return None, issued, str(e)


def pid_alive(pid: int):
    """True/False bila pasti; None bila tak bisa dipastikan (mis. access denied aneh)."""
    if not pid or pid <= 0:
        return False
    try:
        if os.name == "nt":
            import ctypes
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            k32 = ctypes.windll.kernel32
            h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if not h:
                # 5 = access denied (proses ada tapi terlindungi) → anggap hidup
                return True if k32.GetLastError() == 5 else False
            alive = None
            code = ctypes.c_ulong()
            if k32.GetExitCodeProcess(h, ctypes.byref(code)):
                alive = code.value == 259  # STILL_ACTIVE
            k32.CloseHandle(h)
            return alive
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except Exception:  # noqa: BLE001
        return None


def process_start_token(pid: int) -> Optional[str]:
    """Stable process-start identity so a recycled PID is not treated as owner."""
    if not pid or pid <= 0:
        return None
    try:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes
            k32 = ctypes.windll.kernel32
            handle = k32.OpenProcess(0x1000, False, pid)
            if not handle:
                return None
            created = wintypes.FILETIME()
            exited = wintypes.FILETIME()
            kernel = wintypes.FILETIME()
            user = wintypes.FILETIME()
            ok = k32.GetProcessTimes(
                handle,
                ctypes.byref(created), ctypes.byref(exited),
                ctypes.byref(kernel), ctypes.byref(user),
            )
            k32.CloseHandle(handle)
            if not ok:
                return None
            return str((created.dwHighDateTime << 32) | created.dwLowDateTime)
        with open(f"/proc/{pid}/stat", "r", encoding="utf-8") as handle:
            return handle.read().split()[21]
    except (OSError, IndexError):
        return None


def process_executable(pid: int) -> Optional[str]:
    """Best-effort executable basename, used for legacy locks without a token."""
    try:
        if os.name == "nt":
            import ctypes
            k32 = ctypes.windll.kernel32
            handle = k32.OpenProcess(0x1000, False, pid)
            if not handle:
                return None
            size = ctypes.c_ulong(32768)
            buffer = ctypes.create_unicode_buffer(size.value)
            ok = k32.QueryFullProcessImageNameW(
                handle, 0, buffer, ctypes.byref(size)
            )
            k32.CloseHandle(handle)
            return os.path.basename(buffer.value).lower() if ok else None
        return os.path.basename(os.readlink(f"/proc/{pid}/exe")).lower()
    except OSError:
        return None


def lock_owner_alive(pid: Optional[int], start_token: Optional[str]) -> bool:
    alive = pid_alive(pid) if pid else False
    if alive is not True:
        return False
    current_token = process_start_token(int(pid))
    if start_token and current_token:
        return start_token == current_token
    # Legacy locks stored only PID. Reject a recycled non-Python process, which
    # is the observed Windows failure mode; unknown protected processes remain
    # conservatively alive.
    executable = process_executable(int(pid))
    return executable is None or executable.startswith(("python", "py.exe"))


def read_lock_file(path: str):
    """Return (pid, age_seconds, process_start_token), compatible with old locks."""
    pid = None
    age = None
    start_token = None
    try:
        raw = open(path, "r", encoding="utf-8", errors="ignore").read().strip()
        head = raw.split("|")
        if head and head[0].isdigit():
            pid = int(head[0])
        if len(head) > 1 and head[1].isdigit():
            age = max(0.0, time.time() - int(head[1]))
        if len(head) > 2 and head[2]:
            start_token = head[2]
    except OSError:
        pass
    if age is None:
        try:
            age = max(0.0, time.time() - os.path.getmtime(path))
        except OSError:
            pass
    return pid, age, start_token


def acquire_daemon_lock(path: str) -> None:
    """Prevent duplicate managed daemons and recover a dead owner's lock."""
    lock_path = os.path.abspath(path)
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)

    def create() -> None:
        descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(
                f"{os.getpid()}|{int(time.time())}|"
                f"{process_start_token(os.getpid()) or ''}\n"
            )
            handle.flush()
            os.fsync(handle.fileno())

    try:
        create()
    except FileExistsError:
        owner_pid, _, owner_token = read_lock_file(lock_path)
        if lock_owner_alive(owner_pid, owner_token):
            raise RuntimeError(
                f"Managed daemon lain masih aktif (pid {owner_pid})."
            )
        try:
            os.remove(lock_path)
        except FileNotFoundError:
            pass
        create()

    def release() -> None:
        owner_pid, _, owner_token = read_lock_file(lock_path)
        if (owner_pid != os.getpid()
                or owner_token != process_start_token(os.getpid())):
            return
        try:
            os.remove(lock_path)
        except FileNotFoundError:
            pass

    atexit.register(release)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _read_json(path: str) -> Optional[Dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
            return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def _write_json_atomic(path: str, value: Dict[str, Any]) -> None:
    """Write small cross-process control files without exposing partial JSON."""
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    temp = f"{path}.{os.getpid()}.{int(time.time() * 1000)}.tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)


def runtime_config_dir(config_path: str) -> str:
    """Folder konfigurasi runtime yang sama dengan lib/runtime-config.ts.

    Aplikasi web menulis setiap konfigurasi yang bisa diubah admin ke volume
    `db/` yang permanen, karena `config/` ikut dibangun ke dalam image dan
    kembali ke nilai bawaan setiap kali image dibangun ulang. Worker harus
    memakai urutan pencarian yang persis sama supaya daemon dan aplikasi web
    tidak pernah membaca dua berkas yang berbeda.
    """
    explicit = (os.getenv("WIOM_RUNTIME_CONFIG_DIR") or "").strip()
    if explicit:
        return os.path.abspath(explicit)
    state_db = (os.getenv("DUCKDB_STATE_PATH") or "").strip()
    if state_db:
        return os.path.join(
            os.path.dirname(os.path.abspath(state_db)), "runtime-config"
        )
    config_dir = os.path.dirname(os.path.abspath(config_path))
    # Sudah menunjuk ke folder runtime (mis. dipanggil ulang oleh daemon).
    if os.path.basename(config_dir) == "runtime-config":
        return config_dir
    return os.path.join(os.path.dirname(config_dir), "db", "runtime-config")


def resolve_config_path(config_path: str) -> str:
    """Salinan runtime bila ada; kalau tidak, nilai bawaan dari image."""
    runtime = os.path.join(
        runtime_config_dir(config_path), os.path.basename(config_path)
    )
    if os.path.abspath(runtime) != os.path.abspath(config_path) and os.path.isfile(runtime):
        return runtime
    return config_path


def load_runtime_config(config_path: str) -> Dict[str, Any]:
    """Load public settings and merge credentials from an ignored sidecar/env."""
    config_path = resolve_config_path(config_path)
    config = _read_json(config_path)
    if not config:
        raise ValueError(f"Konfigurasi sync tidak valid atau tidak ditemukan: {config_path}")

    # The web app writes credentials to the persistent db/ volume (see
    # RUNTIME_CONFIG_DIR in lib/superset-sync.ts); older installs still have
    # them beside the config file. Read the runtime copy first and fall back,
    # so a cookie saved in Settings is picked up without touching this config.
    secret_ref = config.get("secret_file")
    secret_data: Dict[str, Any] = {}
    if secret_ref:
        config_dir = os.path.dirname(os.path.abspath(config_path))
        secret_ref = str(secret_ref)
        runtime_dir = runtime_config_dir(config_path)
        candidates = []
        if os.path.isabs(secret_ref):
            candidates.append(secret_ref)
        else:
            candidates.append(os.path.join(runtime_dir, os.path.basename(secret_ref)))
            candidates.append(os.path.join(config_dir, secret_ref))
        for candidate in candidates:
            secret_data = _read_json(candidate) or {}
            if secret_data:
                log.info("Kredensial Superset dibaca dari %s", candidate)
                break

    superset = config.setdefault("superset", {})
    auth = superset.setdefault("auth", {})
    for key, value in (secret_data.get("auth") or {}).items():
        if value and not auth.get(key):
            auth[key] = value

    base_url = (os.getenv("SUPERSET_BASE_URL") or "").strip()
    if base_url:
        superset["base_url"] = base_url
    for key, env_name in {
        "username": "SUPERSET_USERNAME",
        "password": "SUPERSET_PASSWORD",
        "access_token": "SUPERSET_ACCESS_TOKEN",
    }.items():
        value = (os.getenv(env_name) or "").strip()
        if value:
            auth[key] = value
    cookie_header = (os.getenv("SUPERSET_COOKIE_HEADER") or "").strip()
    session_cookie = (os.getenv("SUPERSET_SESSION_COOKIE") or "").strip()
    if cookie_header:
        auth["cookie_header"] = cookie_header
    elif session_cookie:
        auth["cookie_header"] = f"session={session_cookie}"
    return config


def _iso_after(seconds: float) -> str:
    return datetime.fromtimestamp(time.time() + max(0, seconds), tz=timezone.utc).isoformat()


class AuthConfigurationError(ValueError):
    """
    The configured auth mode cannot be satisfied by the secrets available.

    This is a deployment/configuration fault, not a Superset fault: nothing was
    ever sent to the server. Kept as its own type so classify_error() can label
    it exactly instead of inferring from message text, which previously let it
    fall through to UNKNOWN_ERROR and told the operator nothing.
    """


# ----------------------------------------------------------------------------- #
# 1) Superset client  --  auth + KEYSET-paginated SQL Lab extraction
# ----------------------------------------------------------------------------- #
class SupersetClient:
    """
    Extracts arbitrary tables via Superset SQL Lab's synchronous execute endpoint.
    KEYSET pagination keeps every request small (< row limit) and synchronous,
    which is far more robust than OFFSET on large tables.
    """

    def __init__(self, cfg: Dict[str, Any]):
        import requests  # imported lazily so DuckDB-only smoke tests need no network deps

        self.base = cfg["base_url"].rstrip("/")
        self.database_id = cfg.get("database_id")  # hanya dipakai mode sql_lab
        self.schema = cfg.get("schema")
        self.timeout = cfg.get("timeout_sec", 120)
        self.s = requests.Session()

        auth = cfg.get("auth", {})
        self._auth = auth  # disimpan utk re-login otomatis saat Bearer kedaluwarsa
        # Header ala browser DIPASANG SEBELUM auth — Cloudflare kerap memblokir UA python-requests
        self.s.headers.update({
            "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                           "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"),
            "Accept": "application/json",
            "Referer": self.base, "Content-Type": "application/json",
        })
        for hk, hv in (auth.get("headers") or {}).items():  # header tambahan (mis. Authorization)
            self.s.headers[hk] = hv
        # cookie_header: tempel SELURUH nilai header Cookie dari DevTools → Network.
        # Penting bila ada proxy auth (CF_Authorization / _oauth2_proxy dll.) yang wajib ikut.
        raw_ck = (auth.get("cookie_header") or "").strip()
        if raw_ck:
            for part in raw_ck.split(";"):
                k, _, v = part.strip().partition("=")
                if k and v:
                    self.s.cookies.set(k, v)
        for k, v in auth.get("cookies", {}).items():
            if v:
                self.s.cookies.set(k, v)
        has_cookies = len(self.s.cookies) > 0
        has_creds = bool(auth.get("username") and auth.get("password"))
        mode = auth.get("mode", "auto")
        if mode == "bearer":
            if not str(auth.get("access_token") or "").strip():
                raise AuthConfigurationError(
                    "auth.mode='bearer' tetapi access token kosong. "
                    "Isi SUPERSET_ACCESS_TOKEN pada environment deployment, atau "
                    "simpan lewat Pengaturan → Superset Sync.")
            self.s.headers["Authorization"] = f"Bearer {auth['access_token']}"
        elif mode == "cookie":
            if not has_cookies:
                # The secrets file is excluded from the deployment image on
                # purpose (.dockerignore), so in a container this mode only
                # works when the cookie arrives through the environment.
                raise AuthConfigurationError(
                    "auth.mode='cookie' tetapi cookie kosong. Pada deployment container "
                    "file config/.superset-sync.secrets.json sengaja tidak ikut ke image, "
                    "jadi cookie harus datang dari environment: isi SUPERSET_COOKIE_HEADER "
                    "(seluruh nilai header Cookie dari DevTools) atau SUPERSET_SESSION_COOKIE. "
                    "Untuk deployment yang tidak dijaga, auth.mode='auto' + "
                    "SUPERSET_USERNAME/SUPERSET_PASSWORD lebih tahan lama karena cookie kedaluwarsa.")
        elif mode in ("login", "auto"):
            if mode == "auto" and not has_creds:
                if not has_cookies:
                    raise AuthConfigurationError(
                        "Kredensial Superset kosong. Isi SUPERSET_USERNAME + SUPERSET_PASSWORD, "
                        "atau SUPERSET_COOKIE_HEADER, pada environment deployment.")
                log.info("Auth: memakai cookie (tanpa kredensial login)")
            else:
                try:
                    self._login_any(auth["username"], auth["password"],
                                    auth.get("provider", "db"))
                except Exception as e:  # noqa: BLE001
                    if has_cookies:
                        log.warning("Login API gagal (%s) — LANJUT memakai cookie yang tersedia.",
                                    str(e)[:150])
                    else:
                        raise
        else:
            raise AuthConfigurationError(f"Unknown auth mode: {mode}")
        self.csrf = self._fetch_csrf() if auth.get("csrf", True) else None
        if self.csrf:
            self.s.headers["X-CSRFToken"] = self.csrf

    def _login_any(self, username: str, password: str, provider: str) -> None:
        """Coba provider dari config; bila 'db' ditolak 401, coba 'ldap' sekali."""
        try:
            self._login(username, password, provider)
            return
        except RuntimeError as e:
            if provider == "db" and "401" in str(e):
                log.info("provider 'db' ditolak — mencoba provider 'ldap'…")
                self._login(username, password, "ldap")
                return
            raise

    def _login(self, username: str, password: str, provider: str) -> None:
        try:
            r = self._http("POST", f"{self.base}/api/v1/security/login", tries=2,
                           json={"username": username, "password": password,
                                 "provider": provider, "refresh": True})
        except RuntimeError as e:
            raise RuntimeError(
                f"Login API gagal: {e}. Cek username/password & provider ('db' atau 'ldap'). "
                "Bila login web memakai Google/SSO, endpoint login biasanya nonaktif — "
                "pakai auth.cookie_header (salin SELURUH header Cookie dari DevTools).") from e
        tok = r.json()
        self._access_token = tok.get("access_token")
        if not self._access_token:
            raise RuntimeError(f"Login API tidak mengembalikan access_token: {str(tok)[:180]}")
        self.s.headers["Authorization"] = f"Bearer {self._access_token}"
        log.info("Login API OK — Bearer token aktif (provider=%s)", provider)

    TRANSIENT = {429, 502, 503, 504, 524}  # gateway/Cloudflare — layak retry

    @staticmethod
    def classify_error(error: Exception) -> str:
        """Classify an exception into a structured error category."""
        msg = str(error)
        # Checked by type, before any message sniffing: a missing secret is a
        # configuration fault the operator can fix, and it must never be
        # reported as UNKNOWN_ERROR or confused with a rejected login.
        if isinstance(error, AuthConfigurationError):
            return "AUTH_CONFIGURATION_ERROR"
        if "HTTP 401" in msg or "login" in msg.lower():
            return "SUPERSET_AUTH_ERROR"
        if "HTTP 403" in msg or "CSRF" in msg.upper():
            return "SUPERSET_FORBIDDEN"
        if "HTTP 404" in msg:
            return "SUPERSET_NOT_FOUND"
        if "HTTP 429" in msg:
            return "SUPERSET_RATE_LIMIT"
        if "HTTP 50" in msg or "HTTP 52" in msg:
            return "SUPERSET_SERVER_ERROR"
        if "timeout" in msg.lower() or "timed out" in msg.lower():
            return "SUPERSET_TIMEOUT"
        if "chart/data error" in msg.lower() or "explore_json" in msg.lower():
            return "SUPERSET_QUERY_ERROR"
        if "Columns missing" in msg or "tidak ada" in msg.lower():
            return "CONFIGURATION_ERROR"
        if "lock" in msg.lower() and ("masih" in msg.lower() or "basi" in msg.lower()):
            return "SYNC_LOCKED"
        if "database" in msg.lower() or "duckdb" in msg.lower() or "write" in msg.lower():
            return "DATABASE_WRITE_ERROR"
        return "UNKNOWN_ERROR"

    def _http(self, method: str, url: str, *, tries: int = 3, **kw):
        """Request dgn retry utk error transien; error final memuat cuplikan body
        (JSON pesan Superset / halaman Cloudflare) agar mudah didiagnosis."""
        kw.setdefault("timeout", self.timeout)
        delay = 3.0
        last: Any = None
        relogged = False
        for i in range(1, tries + 1):
            try:
                r = self.s.request(method, url, **kw)
            except Exception as e:  # koneksi putus / DNS / TLS
                last = e
                if i == tries:
                    raise RuntimeError(f"{method} {url} gagal: {e}") from e
                log.warning("  koneksi transien (%s) — retry %d/%d dalam %.0fs", e, i, tries, delay)
                time.sleep(delay); delay *= 2.2
                continue
            if r.status_code in self.TRANSIENT and i < tries:
                log.warning("  HTTP %d transien — retry %d/%d dalam %.0fs", r.status_code, i, tries, delay)
                time.sleep(delay); delay *= 2.2
                continue
            _a = getattr(self, "_auth", {}) or {}
            if (r.status_code == 401 and not relogged
                    and _a.get("mode") in ("login", "auto")
                    and _a.get("username") and _a.get("password")
                    and "/api/v1/security/login" not in url):
                relogged = True
                log.info("  401 — Bearer kedaluwarsa? mencoba login ulang…")
                try:
                    a = self._auth
                    self._login_any(a["username"], a["password"], a.get("provider", "db"))
                    continue  # ulangi request dengan token baru
                except Exception as le:  # noqa: BLE001
                    log.warning("  re-login gagal: %s", str(le)[:160])
            if r.status_code >= 400:
                body = (r.text or "")[:280].replace("\n", " ")
                disp = url.split("?")[0]  # buang query panjang agar BODY error tetap terlihat
                raise RuntimeError(f"HTTP {r.status_code} {r.reason} pada {disp} — {body}")
            return r
        raise RuntimeError(f"{method} {url} gagal setelah {tries}x: {last}")

    def _fetch_csrf(self) -> Optional[str]:
        try:
            r = self._http("GET", f"{self.base}/api/v1/security/csrf_token/",
                           tries=2, timeout=min(self.timeout, 30))
            return r.json().get("result")
        except Exception as e:  # noqa: BLE001
            log.warning("CSRF fetch failed (%s); continuing without it", e)
            return None

    def _execute(self, sql: str) -> List[Dict[str, Any]]:
        payload = {
            "database_id": self.database_id,
            "sql": sql,
            "runAsync": False,
            "select_as_cta": False,
        }
        if self.schema:
            payload["schema"] = self.schema
        r = self._http("POST", f"{self.base}/api/v1/sqllab/execute/",
                       data=json.dumps(payload))
        return r.json().get("data", [])

    @staticmethod
    def _quote(v: Any, typ: str) -> str:
        if typ in ("int", "float", "number"):
            return str(v)
        # default: string/timestamp -> single-quote, escape embedded quotes
        return "'" + str(v).replace("'", "''") + "'"

    def keyset_pages(
        self,
        base_sql: str,
        key_col: str,
        key_type: str = "int",
        chunk_size: int = 50000,
        start_after: Optional[Any] = None,
        extra_where: Optional[str] = None,
    ) -> Iterable[List[Dict[str, Any]]]:
        """
        Wrap the job's base SQL as a subquery and page by a monotonically
        increasing key. `extra_where` carries the incremental watermark filter.
        """
        last = start_after
        page_idx = 0
        while True:
            conds = []
            if last is not None:
                conds.append(f"_t.{key_col} > {self._quote(last, key_type)}")
            if extra_where:
                conds.append(f"({extra_where})")
            where = ("WHERE " + " AND ".join(conds)) if conds else ""
            paged = (
                f"SELECT * FROM ( {base_sql} ) _t "
                f"{where} ORDER BY _t.{key_col} ASC LIMIT {chunk_size}"
            )
            rows = self._execute(paged)
            if not rows:
                break
            page_idx += 1
            log.info("  page %d: %d rows (after %s=%s)", page_idx, len(rows), key_col, last)
            yield rows
            last = rows[-1][key_col]
            if len(rows) < chunk_size:
                break


# ----------------------------------------------------------------------------- #
# 1a) Superset DATASET client -- Chart Data API, TANPA SQL Lab
#     Jalur yang sama dengan Auto Sync v5.5 (Apps Script): cukup cookie session
#     viewer yang bisa melihat dashboard/dataset. Filter, agregasi, orderby,
#     dan paginasi dikerjakan server-side oleh Superset.
# ----------------------------------------------------------------------------- #
class SupersetDatasetClient(SupersetClient):
    """
    Config job (blok "dataset"):
      {"id": 123,                       # dataset id (lihat URL /explore/?datasource_id=123)
       "page": "keyset" | "offset",
       "key": "id",                     # kolom keyset (page=keyset)
       "orderby": ["rack_name"],        # urutan stabil (page=offset)
       "columns": {"raw": "target"},    # dimensi: nama kolom dataset -> nama tabel DuckDB
       "metrics": [{"agg":"SUM","column":"stock","label":"stock_qty"}],  # opsional
       "filters": [{"col":"origin_id","op":"IN","val":[1,2]}]}           # opsional (statis)
    Watermark incremental otomatis diterjemahkan jadi filter `raw_col > nilai`.
    """

    def _chart_data(
        self,
        dataset_id: int,
        columns: List[str],
        metrics: List[Dict[str, Any]],
        filters: List[Dict[str, Any]],
        orderby: List[List[Any]],
        row_limit: int,
        row_offset: int,
        extras: Optional[Dict[str, Any]] = None,
        time_range: Optional[str] = None,
        granularity: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        q: Dict[str, Any] = {
            "columns": columns,
            "metrics": metrics,
            "filters": filters,
            "orderby": orderby,
            "row_limit": row_limit,
            "row_offset": row_offset,
        }
        if extras:
            q["extras"] = extras
        if time_range:
            q["time_range"] = time_range
        if granularity:
            q["granularity"] = granularity
        payload: Dict[str, Any] = {
            "datasource": {"id": dataset_id, "type": "table"},
            "force": bool(self.force_refresh),
            "queries": [q],
            "result_format": "json",
            "result_type": "results",
        }
        r = self._http("POST", f"{self.base}/api/v1/chart/data",
                       data=json.dumps(payload))
        res = (r.json().get("result") or [{}])[0]
        if res.get("error"):
            raise RuntimeError(f"Superset chart/data error: {res['error']}")
        return res.get("data", [])

    def __init__(self, cfg: Dict[str, Any]):
        super().__init__(cfg)
        self.force_refresh = cfg.get("force_refresh", False)  # bypass cache (pelajaran v5.5)
        # Cap server (SQL_MAX_ROW) — SATU request tak bisa melewatinya; TOTAL tak terbatas
        # lewat paginasi (POST) & segmentasi (legacy agregasi).
        self.server_row_cap = int(cfg.get("server_row_cap", 5000000))

    @staticmethod
    def _metric_expr(m: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "expressionType": "SIMPLE",
            "aggregate": m["agg"].upper(),
            "column": {"column_name": m["column"]},
            "label": m["label"],
        }

    def chart_saved_query(self, chart_id: int):
        """Baca definisi TERSIMPAN sebuah chart → (filters, where_sql, time_range, granularity).
        Sumber: query_context (paling akurat) → fallback params/form_data (adhoc_filters).
        Catatan: filter dari FILTER BAR dashboard (native filter) TIDAK tersimpan di chart."""
        cache = getattr(self, "_chart_meta_cache", None)
        if cache is None:
            cache = self._chart_meta_cache = {}
        if chart_id in cache:
            return cache[chart_id]
        r = self._http("GET", f"{self.base}/api/v1/chart/{int(chart_id)}")
        res = r.json().get("result", {})
        filters: List[Dict[str, Any]] = []
        wheres: List[str] = []
        time_range: Optional[str] = None
        granularity: Optional[str] = None
        qc_raw = res.get("query_context")
        if qc_raw:
            try:
                q = (json.loads(qc_raw).get("queries") or [{}])[0]
                for f in q.get("filters", []) or []:
                    if f.get("col") and f.get("op"):
                        filters.append({k: f[k] for k in ("col", "op", "val") if k in f})
                w = (q.get("extras") or {}).get("where")
                if w:
                    wheres.append(w)
                time_range = q.get("time_range") or time_range
                granularity = q.get("granularity") or granularity
            except Exception as e:  # noqa: BLE001
                log.warning("chart %s: query_context tak terbaca (%s) — pakai params",
                            chart_id, str(e)[:80])
        if not filters and not wheres and res.get("params"):
            try:
                fd = json.loads(res["params"])
                for af in fd.get("adhoc_filters", []) or []:
                    if af.get("clause") != "WHERE":
                        continue
                    if af.get("expressionType") == "SIMPLE" and af.get("subject"):
                        flt = {"col": af["subject"], "op": af.get("operator", "==")}
                        if "comparator" in af and af["comparator"] not in (None, ""):
                            flt["val"] = af["comparator"]
                        filters.append(flt)
                    elif af.get("expressionType") == "SQL" and af.get("sqlExpression"):
                        wheres.append(af["sqlExpression"])
                time_range = fd.get("time_range") or time_range
                granularity = fd.get("granularity_sqla") or granularity
            except Exception as e:  # noqa: BLE001
                log.warning("chart %s: params tak terbaca (%s)", chart_id, str(e)[:80])
        if time_range in ("No filter", "no filter"):
            time_range = None
        filters = [f for f in filters
                   if not (f.get("op") == "TEMPORAL_RANGE"
                           and str(f.get("val", "")).lower() in ("no filter", "", "none"))]
        row_limit: Optional[int] = None
        for blob in (qc_raw, res.get("params")):
            if row_limit is None and blob:
                try:
                    j = json.loads(blob)
                    row_limit = (j.get("queries") or [{}])[0].get("row_limit") \
                        if "queries" in j else j.get("row_limit")
                except Exception:  # noqa: BLE001
                    pass
        out = (filters, " AND ".join(wheres) or None, time_range, granularity, row_limit)
        cache[chart_id] = out
        return out

    def chart_get_rows(self, chart_id: int) -> List[Dict[str, Any]]:
        """GET data chart TERSIMPAN — request GET bebas CSRF, jalan meski POST ditolak.
        Tanpa paginasi: set Row Limit chart >= total baris (mis. 200000)."""
        url = f"{self.base}/api/v1/chart/{int(chart_id)}/data/?format=json&type=full"
        if self.force_refresh:
            url += "&force=true"
        r = self._http("GET", url)
        res = (r.json().get("result") or [{}])[0]
        if res.get("error"):
            raise RuntimeError(f"Superset chart {chart_id} error: {res['error']}")
        return res.get("data", [])

    _MISSING_RE = re.compile(r"Columns missing in dataset: \[([^\]]*)\]")

    def dataset_columns(self, dataset_id: int) -> List[str]:
        """Skema ASLI dataset dari API metadata — sumber kebenaran nama kolom."""
        r = self._http("GET", f"{self.base}/api/v1/dataset/{int(dataset_id)}")
        res = r.json().get("result", {})
        return [c.get("column_name") for c in res.get("columns", []) if c.get("column_name")]

    @staticmethod
    def _finalize(rows: List[Dict[str, Any]], colmap: Dict[str, str],
                  metric_labels: List[str], d: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Rename raw→target + derivasi kolom yang tak dimiliki dataset:
        rack_zone/aisle/bay/level/bin dari sloc_code (PGS-ABB1-01-02-L1-01),
        occupied_cbm = stock_qty × sku_cbm bila kosong."""
        derive = d.get("derive_from_sloc_code", True)
        out: List[Dict[str, Any]] = []
        for r in rows:
            o = {tgt: r.get(raw) for raw, tgt in colmap.items()}
            for lb in metric_labels:
                o[lb] = r.get(lb)
            if derive:
                code = o.get("sloc_code")
                if code:
                    parts = str(code).split("-")
                    if len(parts) >= 6:
                        for k, v in zip(("rack_zone", "aisle", "bay", "level", "bin"),
                                        parts[1:6]):
                            if k not in o:
                                continue
                            if k == "level":
                                # The dataset reports level=1 for most racks
                                # regardless of the real tier, so 53% of rows
                                # collapsed onto one level and the heatmap could
                                # not lay out a bay. The code segment (…-L3-…)
                                # is authoritative and therefore overrides.
                                # Stored WITHOUT the L prefix to match how
                                # capacity rule scopes address a level.
                                text = str(v)
                                o[k] = text[1:] if (text[:1].upper() == "L"
                                                    and text[1:].isdigit()) else text
                            elif o[k] is None or o[k] == "":
                                o[k] = v
                if ("sku_cbm" in o and o.get("sku_cbm") in (None, "")
                        and all(o.get(k) not in (None, "") for k in ("length", "width", "height"))):
                    div = float(d.get("dims_to_cbm_divisor", 1_000_000))  # cm³ → m³
                    try:
                        o["sku_cbm"] = round(
                            float(o["length"]) * float(o["width"]) * float(o["height"]) / div, 6)
                    except (TypeError, ValueError):
                        pass
                if ("occupied_cbm" in o and o.get("occupied_cbm") in (None, "")
                        and o.get("sku_cbm") not in (None, "")):
                    q = o.get("stock_qty", o.get("qty"))
                    try:
                        o["occupied_cbm"] = round(float(q) * float(o["sku_cbm"]), 6)
                    except (TypeError, ValueError):
                        pass
            out.append(o)
        return out

    # ---- Tier-3: legacy /superset/explore_json/ (GET + session cookie, bebas CSRF) ----
    _LEGACY_OP = {"==": "==", "!=": "!=", ">": ">", "<": "<", ">=": ">=", "<=": "<=", "IN": "IN"}

    def _legacy_form_data(self, d: Dict[str, Any], filters: List[Dict[str, Any]],
                          row_limit: int) -> Dict[str, Any]:
        raw_cols = d.get("_raw_cols_effective") or list((d.get("columns") or {}).keys())
        mets = d.get("metrics", [])
        temporal = [f for f in filters if f.get("op") == "TEMPORAL_RANGE"]
        plain = [f for f in filters if f.get("op") != "TEMPORAL_RANGE"]
        adhoc: List[Dict[str, Any]] = [{
            "clause": "WHERE", "expressionType": "SIMPLE",
            "subject": f["col"], "operator": self._LEGACY_OP.get(f["op"], f["op"]),
            **({"comparator": f["val"]} if "val" in f else {}),
        } for f in plain]
        if d.get("_inherited_where"):
            adhoc.append({"clause": "WHERE", "expressionType": "SQL",
                          "sqlExpression": d["_inherited_where"]})
        fd: Dict[str, Any] = {
            "datasource": f"{int(d['id'])}__table",
            "viz_type": "table",
            "adhoc_filters": adhoc,
            "row_limit": int(row_limit),
        }
        tr = d.get("_inherited_time_range") or (temporal[0].get("val") if temporal else None)
        gr = d.get("_inherited_granularity") or (temporal[0].get("col") if temporal else None)
        if tr:
            fd["time_range"] = tr
        if gr:
            fd["granularity_sqla"] = gr
        if mets:  # agregasi server-side (mis. SUM(stock) -> stock_qty)
            fd["query_mode"] = "aggregate"
            fd["groupby"] = raw_cols
            fd["metrics"] = [self._metric_expr(m) for m in mets]
        else:
            fd["query_mode"] = "raw"
            fd["all_columns"] = raw_cols
            key = d.get("key")
            if key:
                fd["order_by_cols"] = [json.dumps([key, True])]
        return fd

    def legacy_rows(self, d: Dict[str, Any], filters: List[Dict[str, Any]],
                    row_limit: int) -> List[Dict[str, Any]]:
        fd = self._legacy_form_data(d, filters, row_limit)
        url = (f"{self.base}/superset/explore_json/?form_data={quote(json.dumps(fd))}"
               + ("&force=true" if self.force_refresh else ""))
        r = self._http("GET", url)
        body = r.json()
        data = body.get("data", body)
        if isinstance(data, dict):
            rows = data.get("records") or data.get("data") or []
        else:
            rows = data or []
        if body.get("error") or (isinstance(data, dict) and data.get("error")):
            raise RuntimeError(f"legacy explore_json error: {body.get('error') or data.get('error')}")
        return rows

    def legacy_pages(self, job: "Job", watermark: Optional[str]) -> Iterable[List[Dict[str, Any]]]:
        d = {**(job.dataset or {})}
        d["id"] = int(d["id"])
        colmap: Dict[str, str] = d.get("columns") or {}
        metric_labels = [m["label"] for m in d.get("metrics", [])]
        base_filters = list(d.get("_inherited_filters", [])) + list(d.get("filters", []))
        if watermark and job.watermark_column:
            raw_wm = next((raw for raw, tgt in colmap.items()
                           if tgt == job.watermark_column), job.watermark_column)
            base_filters.append({"col": raw_wm, "op": ">", "val": watermark})

        def rename(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
            return self._finalize(rows, colmap, metric_labels, d)

        capv = int(d.get("server_row_cap", self.server_row_cap))
        chunk = min(job.chunk_size, capv)
        if d.get("page") == "keyset" and d.get("key") and not d.get("metrics"):
            key_raw = d["key"]; last = None; page_idx = 0
            while True:
                filters = list(base_filters)
                if last is not None:
                    filters.append({"col": key_raw, "op": ">", "val": last})
                rows = self.legacy_rows(d, filters, chunk)
                if not rows:
                    break
                page_idx += 1
                log.info("  [legacy] page %d: %d rows (keyset %s>%s)",
                         page_idx, len(rows), key_raw, last)
                yield rename(rows)
                last = rows[-1][key_raw]
                if len(rows) < chunk:
                    break
        else:
            # Agregasi tanpa offset di legacy → SEGMENTASI: pecah per nilai kolom segmen
            # (default location_id). Nilai segmen diambil GRATIS dari filter IN yang
            # diwarisi/di-config; bila tak ada, di-discover via query kecil.
            seg_cfg = d.get("segment_by")
            seg_cols = ([seg_cfg] if isinstance(seg_cfg, str) else list(seg_cfg or [])) \
                or (["location_id"] if "location_id" in colmap else [])
            seg_cols = [c for c in seg_cols if c in colmap]

            def discover(col: str, flt: List[Dict[str, Any]]) -> List[Any]:
                inx = next((f for f in flt if f.get("col") == col and
                            str(f.get("op", "")).upper() == "IN" and f.get("val")), None)
                if inx:
                    return list(inx["val"])
                d_disc = {**d, "columns": {col: col}, "_raw_cols_effective": [col],
                          "metrics": [{"agg": "COUNT", "column": col, "label": "_n"}]}
                found = self.legacy_rows(d_disc, flt, chunk)
                return [r[col] for r in found if r.get(col) is not None]

            def pull(flt: List[Dict[str, Any]], depth: int) -> Iterable[List[Dict[str, Any]]]:
                rows = self.legacy_rows(d, flt, chunk)
                if len(rows) >= chunk and depth < len(seg_cols):
                    col = seg_cols[depth]
                    vals = discover(col, flt)
                    log.info("  [legacy] segmen %s ≥ cap %d → pecah per %s (%d nilai)",
                             "root" if depth == 0 else "sub", capv, col, len(vals))
                    for v in vals:
                        yield from pull(flt + [{"col": col, "op": "==", "val": v}], depth + 1)
                    return
                if len(rows) >= capv:
                    log.warning("  [legacy] %d baris = cap server (%d) — kemungkinan TERPOTONG; "
                                "tambah kolom di dataset.segment_by", len(rows), capv)
                if rows:
                    log.info("  [legacy] %d baris%s", len(rows),
                             "" if depth == 0 else f" (segmen kedalaman {depth})")
                renamed = rename(rows)
                for i in range(0, len(renamed), chunk):
                    yield renamed[i:i + chunk]

            if seg_cols:
                # langsung pecah pada segmen pertama (hindari 1 tarikan besar percuma)
                col = seg_cols[0]
                vals = discover(col, base_filters)
                if vals:
                    log.info("  [legacy] agregasi tersegmentasi per %s: %d segmen "
                             "(total TAK TERBATAS, tiap segmen ≤ cap %d)", col, len(vals), capv)
                    base_wo = [f for f in base_filters
                               if not (f.get("col") == col and str(f.get("op", "")).upper() == "IN")]
                    for v in vals:
                        yield from pull(base_wo + [{"col": col, "op": "==", "val": v}], 1)
                    return
            yield from pull(base_filters, 0)

    def dataset_pages(self, job: "Job", watermark: Optional[str]) -> Iterable[List[Dict[str, Any]]]:
        d = job.dataset or {}
        ds_id = d.get("id")
        if not (isinstance(ds_id, int) or str(ds_id).isdigit()):
            raise ValueError(
                f"[{job.name}] dataset.id belum diisi ANGKA (sekarang: {ds_id!r}). "
                "Lihat _baca_dulu di config: ambil dari URL explore ?datasource_id=ANGKA.")
        d = {**d, "id": int(ds_id)}
        colmap: Dict[str, str] = d.get("columns") or {}
        if not colmap:
            raise ValueError(f"[{job.name}] dataset.columns (raw->target) wajib diisi")
        metrics = [self._metric_expr(m) for m in d.get("metrics", [])]
        metric_labels = [m["label"] for m in d.get("metrics", [])]
        base_filters = list(d.get("filters", []))

        # watermark incremental -> filter di kolom RAW
        if watermark and job.watermark_column:
            raw_wm = next((raw for raw, tgt in colmap.items() if tgt == job.watermark_column),
                          job.watermark_column)
            base_filters.append({"col": raw_wm, "op": ">", "val": watermark})

        cid = d.get("chart_id")
        chart_id: Optional[int] = int(cid) if (isinstance(cid, int) or str(cid).isdigit()) else None

        # --- Warisi FILTER TERSIMPAN chart bila chart_id diisi (bukan tarik seluruh dataset) ---
        extras_qc: Optional[Dict[str, Any]] = None
        time_range: Optional[str] = None
        granularity: Optional[str] = None
        if chart_id is not None and d.get("inherit_chart_filters", True):
            try:
                inh_f, inh_w, inh_t, inh_g, _inh_rl = self.chart_saved_query(chart_id)
                if inh_f:
                    base_filters = list(inh_f) + base_filters
                if inh_w:
                    extras_qc = {"where": inh_w}
                time_range, granularity = inh_t, inh_g
                log.info("[%s] mewarisi filter chart %d → %s%s%s", job.name, chart_id,
                         inh_f if inh_f else "—",
                         f" | WHERE {inh_w}" if inh_w else "",
                         f" | time_range={inh_t} ({inh_g})" if inh_t else "")
                if isinstance(job.dataset, dict):  # utk jalur legacy
                    job.dataset["_inherited_filters"] = list(inh_f)
                    job.dataset["_inherited_where"] = inh_w
                    job.dataset["_inherited_time_range"] = inh_t
                    job.dataset["_inherited_granularity"] = inh_g
                d["_inherited_where"] = inh_w
                d["_inherited_time_range"] = inh_t
                d["_inherited_granularity"] = inh_g
            except Exception as ce:  # noqa: BLE001
                log.warning("[%s] gagal membaca filter chart %d (%s) — lanjut TANPA warisan",
                            job.name, chart_id, str(ce)[:120])

        mode = d.get("page", "offset")
        capv = int(d.get("server_row_cap", self.server_row_cap))
        chunk = min(job.chunk_size, capv)  # per-request ≤ cap server; TOTAL tak terbatas
        raw_cols = list(colmap.keys())

        # --- Selaraskan dengan skema dataset ASLI (introspeksi; anti tebak-tebakan) ---
        real: set = set()
        try:
            real = set(self.dataset_columns(d["id"]))
        except Exception as ie:  # noqa: BLE001 — endpoint metadata bisa saja dibatasi
            log.info("[%s] introspeksi dataset %s gagal (%s) — lanjut, mengandalkan "
                     "pemangkasan dari pesan error server", job.name, d["id"], str(ie)[:90])
        if real:
            gone = [c for c in raw_cols if c not in real]
            if gone:
                log.warning("[%s] kolom config TIDAK ADA di dataset %s → dilewati: %s "
                            "(target di-NULL-kan / diturunkan dari sloc_code). "
                            "Kolom tersedia: %s", job.name, d["id"], gone, sorted(real))
                raw_cols = [c for c in raw_cols if c in real]
            for mt in d.get("metrics", []):
                if mt["column"] not in real:
                    raise ValueError(
                        f"[{job.name}] kolom metric '{mt['column']}' tidak ada di dataset "
                        f"{d['id']}. Kolom tersedia: {sorted(real)}")
            if mode == "keyset" and d.get("key") and d["key"] not in real:
                raise ValueError(
                    f"[{job.name}] dataset.key '{d['key']}' tidak ada di dataset {d['id']}. "
                    f"Kolom tersedia: {sorted(real)}")
            ob_cfg = list(d.get("orderby") or [])
            ob_ok = [c for c in ob_cfg if c in real]
            if ob_cfg and ob_ok != ob_cfg:
                log.warning("[%s] orderby disaring ke kolom valid: %s", job.name, ob_ok)
                d["orderby"] = ob_ok or raw_cols[:1]
        if not raw_cols:
            raise ValueError(f"[{job.name}] tidak ada kolom config yang cocok dengan dataset "
                             f"{d['id']} — jalankan --columns utk melihat skema asli")
        d["_raw_cols_effective"] = list(raw_cols)
        if isinstance(job.dataset, dict):  # propagasi ke legacy_pages (baca job.dataset asli)
            job.dataset["_raw_cols_effective"] = list(raw_cols)
            if "orderby" in d:
                job.dataset["orderby"] = d.get("orderby")

        def rename(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
            return self._finalize(rows, colmap, metric_labels, d)

        # --- Probe POST 1 baris; bila ditolak (401/403/CSRF) & ada chart_id -> fallback GET ---
        use_get = str(d.get("prefer", "")).lower() == "chart_get" and chart_id is not None
        if not use_get:
            probe_ob = [[d["key"], True]] if (mode == "keyset" and d.get("key")) else \
                       [[c, True] for c in (d.get("orderby") or raw_cols[:1])]
            try:
                self._chart_data(d["id"], raw_cols, metrics, base_filters, probe_ob, 1, 0,
                                 extras=extras_qc, time_range=time_range,
                                 granularity=granularity)
            except RuntimeError as e:
                m = str(e)
                # Pemangkasan berbasis pesan error server (bila introspeksi tak tersedia)
                mm = self._MISSING_RE.search(m)
                if mm and "HTTP 400" in m:
                    gone = re.findall(r"'([^']+)'", mm.group(1))
                    keep = [c for c in raw_cols if c not in gone]
                    bad_metric = [mt["column"] for mt in d.get("metrics", [])
                                  if mt["column"] in gone]
                    if bad_metric:
                        raise ValueError(
                            f"[{job.name}] kolom metric {bad_metric} tidak ada di dataset "
                            f"{d['id']} — jalankan --columns utk melihat skema asli") from e
                    if keep and keep != raw_cols:
                        log.warning("[%s] server melapor kolom hilang %s — dipangkas, "
                                    "dicoba ulang", job.name, gone)
                        raw_cols = keep
                        d["_raw_cols_effective"] = list(raw_cols)
                        if isinstance(job.dataset, dict):
                            job.dataset["_raw_cols_effective"] = list(raw_cols)
                        if d.get("orderby"):
                            d["orderby"] = [c for c in d["orderby"] if c not in gone] \
                                           or raw_cols[:1]
                        probe_ob = [[d["key"], True]] if (mode == "keyset" and d.get("key")) \
                            else [[c, True] for c in (d.get("orderby") or raw_cols[:1])]
                        self._chart_data(d["id"], raw_cols, metrics, base_filters,
                                         probe_ob, 1, 0, extras=extras_qc,
                                         time_range=time_range, granularity=granularity)
                        m = ""  # probe ulang sukses → lanjut normal
                    else:
                        raise
                if m:
                    blocked = any(t in m for t in ("HTTP 401", "HTTP 403")) \
                        or "CSRF" in m.upper() \
                        or ("HTTP 400" in m and "csrf" in m.lower())
                    if not blocked:
                        raise
                    # Tier-2: LEGACY dulu — kolom & warisan filter tetap milik WIOM
                    log.warning("[%s] API v1 ditolak (%s…) — mencoba jalur LEGACY "
                                "explore_json (session cookie)", job.name, m[:90])
                    try:
                        self.legacy_rows({**d, "id": int(d["id"])}, list(base_filters), 1)
                        log.info("[%s] LEGACY OK — memakai explore_json utk job ini", job.name)
                        yield from self.legacy_pages(job, watermark)
                        return
                    except (RuntimeError, ValueError) as le:
                        if chart_id is not None:
                            # Tier-3: GET chart tersimpan (kolom mengikuti chart)
                            log.warning("[%s] LEGACY gagal (%s…) — fallback GET chart %d "
                                        "(kolom mengikuti definisi chart)",
                                        job.name, str(le)[:90], chart_id)
                            use_get = True
                        else:
                            raise RuntimeError(
                                f"[{job.name}] Semua jalur ditolak. v1: {m[:120]} | "
                                f"legacy: {str(le)[:120]}. Jalankan --doctor; kemungkinan "
                                "cookie korup/terpotong (salin ulang via 'Copy value') atau "
                                "isi dataset.chart_id utk fallback GET.") from le
        if use_get:
            rows = self.chart_get_rows(chart_id)  # type: ignore[arg-type]
            if watermark and job.watermark_column:
                raw_wm = next((raw for raw, tgt in colmap.items()
                               if tgt == job.watermark_column), job.watermark_column)
                before = len(rows)
                rows = [r for r in rows if str(r.get(raw_wm, "")) > str(watermark)]
                log.info("[%s] GET mode: filter watermark %s > %s di sisi klien (%d→%d baris)",
                         job.name, raw_wm, watermark, before, len(rows))
            log.info("[%s] GET chart %d: %d baris", job.name, chart_id, len(rows))
            try:
                _f2, _w2, _t2, _g2, rl2 = self.chart_saved_query(chart_id)
                if rl2 and len(rows) >= int(rl2):
                    log.warning("[%s] %d baris = Row Limit chart (%s) — GET tak bisa paging; "
                                "jalur POST/legacy TAK TERBATAS totalnya (naikkan Row Limit chart "
                                "hanya bila terpaksa memakai GET)", job.name, len(rows), rl2)
            except Exception:  # noqa: BLE001
                pass
            renamed = rename(rows)
            for i in range(0, len(renamed), chunk):
                yield renamed[i:i + chunk]
            return

        page_idx = 0
        if mode == "keyset":
            key_raw = d.get("key")
            if not key_raw:
                raise ValueError(f"[{job.name}] page=keyset butuh dataset.key")
            last: Optional[Any] = None
            while True:
                filters = list(base_filters)
                if last is not None:
                    filters.append({"col": key_raw, "op": ">", "val": last})
                rows = self._chart_data(d["id"], raw_cols, metrics, filters,
                                        [[key_raw, True]], chunk, 0, extras=extras_qc,
                                        time_range=time_range, granularity=granularity)
                if not rows:
                    break
                page_idx += 1
                log.info("  page %d: %d rows (keyset %s>%s)", page_idx, len(rows), key_raw, last)
                yield rename(rows)
                last = rows[-1][key_raw]
                if len(rows) < chunk:
                    break
        else:  # offset — total TAK TERBATAS (cap hanya per request); orderby harus total-order
            ob_head = [c for c in (d.get("orderby") or raw_cols[:1]) if c in raw_cols]
            orderby = [[c, True] for c in ob_head + [c for c in raw_cols if c not in ob_head]]
            offset = 0
            while True:
                rows = self._chart_data(d["id"], raw_cols, metrics, base_filters,
                                        orderby, chunk, offset, extras=extras_qc,
                                        time_range=time_range, granularity=granularity)
                if not rows:
                    break
                page_idx += 1
                log.info("  page %d: %d rows (offset %d)", page_idx, len(rows), offset)
                yield rename(rows)
                offset += len(rows)
                if len(rows) < chunk:
                    break

# ----------------------------------------------------------------------------- #
# 1b) ClickHouse client -- HTTP interface langsung (opsional, paling cepat)
#     Memakai ulang keyset_pages/_quote milik SupersetClient (duck-typing).
# ----------------------------------------------------------------------------- #
class ClickHouseClient:
    """
    Sumber alternatif tanpa Superset: POST SQL ke ClickHouse HTTP (port 8123)
    dengan `FORMAT JSON`. Butuh user read-only + akses jaringan ke ClickHouse.
    Config:
      {"url": "http://clickhouse:8123", "user": "wiom_ro",
       "password": "", "database": "default", "timeout_sec": 120}
    """

    def __init__(self, cfg: Dict[str, Any]):
        import requests

        self.url = cfg["url"].rstrip("/")
        self.database = cfg.get("database", "default")
        self.timeout = cfg.get("timeout_sec", 120)
        self.s = requests.Session()
        self.s.auth = (cfg.get("user", "default"), cfg.get("password", ""))

    def _execute(self, sql: str) -> List[Dict[str, Any]]:
        r = self.s.post(
            f"{self.url}/?database={self.database}",
            data=(sql.rstrip().rstrip(";") + " FORMAT JSON").encode("utf-8"),
            timeout=self.timeout,
        )
        r.raise_for_status()
        return r.json().get("data", [])

    _quote = SupersetClient._quote
    keyset_pages = SupersetClient.keyset_pages

# ----------------------------------------------------------------------------- #
# 2) DuckDB sink  --  schema evolution, snapshot / incremental / upsert, retention
# ----------------------------------------------------------------------------- #
def _duckdb_type(series: Any) -> str:
    """Map a pandas column to a DuckDB type.

    Inspects the dtype rather than `type(first_value)`: a frame built from JSON
    rows holds numpy scalars (np.int64/np.float64/np.bool_), which never match
    the Python builtins and would silently fall back to VARCHAR.
    """
    if pd is None:
        return "VARCHAR"
    if pd.api.types.is_bool_dtype(series):
        return "BOOLEAN"
    if pd.api.types.is_integer_dtype(series):
        return "BIGINT"
    if pd.api.types.is_float_dtype(series):
        return "DOUBLE"
    if pd.api.types.is_datetime64_any_dtype(series):
        return "TIMESTAMP"
    return "VARCHAR"


def _schema_file(config: Dict[str, Any]) -> Optional[str]:
    """Locate db/schema.sql across dev checkouts and container layouts.

    `/app/db` is a Docker volume, so the copy the image ships there can be
    shadowed by an empty mount; the script-relative copy survives that.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    db_dir = os.path.dirname(os.path.abspath(str(config.get("duckdb_path") or "db/x")))
    explicit = str(config.get("schema_file") or "").strip()
    candidates = ([explicit] if explicit else []) + [
        os.path.join(db_dir, "schema.sql"),
        os.path.join(here, "schema.sql"),
        os.path.join(here, os.pardir, "db", "schema.sql"),
        os.path.join(os.getcwd(), "db", "schema.sql"),
    ]
    for candidate in candidates:
        path = os.path.abspath(candidate)
        if os.path.isfile(path):
            return path
    return None


def bootstrap_schema(con: "duckdb.DuckDBPyConnection", config: Dict[str, Any]) -> None:
    """Apply the canonical schema before any job writes.

    Without it the first sync into an empty database invents its own tables and
    the dashboard's vw_sloc / vw_stock_latest views never exist. Every statement
    in schema.sql is IF NOT EXISTS / OR REPLACE, so this is idempotent and also
    repairs a database whose views were dropped.
    """
    path = _schema_file(config)
    if not path:
        log.warning("db/schema.sql tidak ditemukan — tabel dibuat dari data "
                    "(view dashboard vw_sloc/vw_stock_latest TIDAK akan dibuat)")
        return
    try:
        with open(path, "r", encoding="utf-8") as handle:
            con.execute(handle.read())
        log.info("skema kanonik diterapkan dari %s", path)
    except Exception as schema_error:  # noqa: BLE001
        # Never block a sync on schema repair; the sink still creates what it
        # needs and the failure is visible in the log.
        log.warning("gagal menerapkan %s (%s) — lanjut tanpa bootstrap skema",
                    path, str(schema_error)[:200])


class DuckDBSink:
    SYNCED_AT = "_synced_at"

    def __init__(self, con: duckdb.DuckDBPyConnection):
        self.con = con
        self._ensure_audit()

    # -- audit ---------------------------------------------------------------- #
    def _ensure_audit(self) -> None:
        self.con.execute(
            """
            CREATE TABLE IF NOT EXISTS _sync_audit (
                job          VARCHAR,
                mode         VARCHAR,
                started_at   TIMESTAMP,
                finished_at  TIMESTAMP,
                rows_pulled  BIGINT,
                rows_written BIGINT,
                watermark    VARCHAR,
                status       VARCHAR,
                message      VARCHAR
            )
            """
        )
        self.con.execute(
            """
            CREATE TABLE IF NOT EXISTS _sync_state (
                job       VARCHAR PRIMARY KEY,
                watermark VARCHAR,
                key_max   VARCHAR,
                updated_at TIMESTAMP
            )
            """
        )

    def audit(self, **row: Any) -> None:
        self.con.execute(
            "INSERT INTO _sync_audit VALUES (?,?,?,?,?,?,?,?,?)",
            [row.get(k) for k in
             ("job", "mode", "started_at", "finished_at", "rows_pulled",
              "rows_written", "watermark", "status", "message")],
        )

    def get_state(self, job: str) -> Dict[str, Any]:
        r = self.con.execute(
            "SELECT watermark, key_max FROM _sync_state WHERE job = ?", [job]
        ).fetchone()
        return {"watermark": r[0], "key_max": r[1]} if r else {"watermark": None, "key_max": None}

    def seconds_since_run(self, job: str) -> Optional[float]:
        """Age of the last successful run, or None if the job never ran."""
        row = self.con.execute(
            "SELECT updated_at FROM _sync_state WHERE job = ?", [job]
        ).fetchone()
        if not row or row[0] is None:
            return None
        last = row[0]
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        return max(0.0, (now_utc() - last).total_seconds())

    def mark_run(self, job: str) -> None:
        """Record a successful run without disturbing an incremental watermark."""
        self.con.execute(
            """
            INSERT INTO _sync_state VALUES (?,?,?,?)
            ON CONFLICT (job) DO UPDATE SET updated_at = excluded.updated_at
            """,
            [job, None, None, now_utc()],
        )

    def set_state(self, job: str, watermark: Optional[str], key_max: Optional[str]) -> None:
        self.con.execute(
            """
            INSERT INTO _sync_state VALUES (?,?,?,?)
            ON CONFLICT (job) DO UPDATE
                SET watermark = excluded.watermark,
                    key_max   = excluded.key_max,
                    updated_at = excluded.updated_at
            """,
            [job, watermark, key_max, now_utc()],
        )

    # -- schema --------------------------------------------------------------- #
    def _table_exists(self, table: str) -> bool:
        return self.con.execute(
            "SELECT 1 FROM information_schema.tables WHERE table_name = ?", [table]
        ).fetchone() is not None

    def _columns(self, table: str) -> List[str]:
        return [r[0] for r in self.con.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_name = ?", [table]
        ).fetchall()]

    def _ensure_table_from_df(self, table: str, df: "pd.DataFrame", stamp: bool) -> None:
        if not self._table_exists(table):
            # DuckDB types an object column by SAMPLING the registered frame, so
            # a frame with no rows leaves it nothing to look at and every object
            # column lands as INTEGER. The first real insert then dies with
            # "Could not convert string ... to INT32". Register the populated
            # frame and cut it with LIMIT 0 so types come from actual values.
            ddl = df
            blank = [c for c in df.columns
                     if df[c].dtype == object and df[c].isna().all()]
            if blank:
                # All-NULL in this batch is unsampleable too; VARCHAR accepts
                # whatever a later batch turns out to carry.
                ddl = df.copy()
                for c in blank:
                    ddl[c] = ddl[c].astype("string")
            self.con.register("_df_ddl", ddl)
            self.con.execute(f'CREATE TABLE "{table}" AS SELECT * FROM _df_ddl LIMIT 0')
            self.con.unregister("_df_ddl")
            if stamp and self.SYNCED_AT not in self._columns(table):
                self.con.execute(f'ALTER TABLE "{table}" ADD COLUMN "{self.SYNCED_AT}" TIMESTAMP')
            return
        # schema evolution: add any new columns seen in the frame
        existing = set(self._columns(table))
        for c in df.columns:
            if c not in existing:
                dtype = _duckdb_type(df[c])
                log.info("  + new column %s (%s) on %s", c, dtype, table)
                self.con.execute(f'ALTER TABLE "{table}" ADD COLUMN "{c}" {dtype}')
        if stamp and self.SYNCED_AT not in existing:
            self.con.execute(f'ALTER TABLE "{table}" ADD COLUMN "{self.SYNCED_AT}" TIMESTAMP')

    def _align_insert(self, table: str, df: "pd.DataFrame", synced_at: datetime, stamp: bool) -> int:
        if stamp:
            df = df.copy()
            df[self.SYNCED_AT] = synced_at
        tbl_cols = self._columns(table)
        # only insert columns the table knows; fill missing with NULL via SELECT list
        self.con.register("_df_ins", df)
        select_list = ", ".join(
            f'"{c}"' if c in df.columns else f'CAST(NULL AS VARCHAR) AS "{c}"'
            for c in tbl_cols
        )
        self.con.execute(
            f'INSERT INTO "{table}" ({", ".join(chr(34)+c+chr(34) for c in tbl_cols)}) '
            f'SELECT {select_list} FROM _df_ins'
        )
        self.con.unregister("_df_ins")
        return len(df)

    # -- write strategies ----------------------------------------------------- #
    def append_snapshot(self, table: str, df: "pd.DataFrame", synced_at: datetime) -> int:
        self._ensure_table_from_df(table, df, stamp=True)
        return self._align_insert(table, df, synced_at, stamp=True)

    def append_incremental(self, table: str, df: "pd.DataFrame", synced_at: datetime) -> int:
        self._ensure_table_from_df(table, df, stamp=True)
        return self._align_insert(table, df, synced_at, stamp=True)

    def upsert(self, table: str, df: "pd.DataFrame", pk: List[str], synced_at: datetime,
               history_table: Optional[str]) -> int:
        # keep full history first (append-only), then merge latest into current
        if history_table:
            self._ensure_table_from_df(history_table, df, stamp=True)
            self._align_insert(history_table, df, synced_at, stamp=True)

        self._ensure_table_from_df(table, df, stamp=True)
        self.con.register("_df_up", df)
        pk_match = " AND ".join(f't."{k}" = s."{k}"' for k in pk)
        # delete-then-insert (portable, avoids needing a UNIQUE constraint)
        self.con.execute(
            f'DELETE FROM "{table}" t USING _df_up s WHERE {pk_match}'
        )
        self.con.unregister("_df_up")
        return self._align_insert(table, df, synced_at, stamp=True)

    # -- retention ------------------------------------------------------------ #
    def thin_snapshots(self, table: str, policy: Dict[str, Any],
                       time_col: str = SYNCED_AT) -> int:
        """Thin out old snapshots, keeping full detail only where it is read.

        A snapshot job appends the ENTIRE current state on every pass, so at a
        30-minute interval the table grows by ~48 full copies per day. Nothing
        reads every one of them: flow rates diff consecutive snapshots over the
        last ~26 h, and the trend chart only needs a curve. So keep every
        snapshot in the recent window, then one per hour, then one per day.

        Rows are deleted whole-snapshot (by distinct timestamp) so any surviving
        snapshot stays internally consistent.
        """
        if not self._table_exists(table) or time_col not in self._columns(table):
            return 0
        keep_all_hours = max(1, int(policy.get("keep_all_hours", 30)))
        hourly_days = max(0, int(policy.get("hourly_days", 7)))
        before = self.con.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
        self.con.execute(
            f'''
            WITH snaps AS (SELECT DISTINCT "{time_col}" AS t FROM "{table}"),
            keep AS (
                SELECT t FROM snaps
                 WHERE t >= now() - INTERVAL {keep_all_hours} HOUR
                UNION
                SELECT min(t) FROM snaps
                 WHERE t <  now() - INTERVAL {keep_all_hours} HOUR
                   AND t >= now() - INTERVAL {hourly_days} DAY
                 GROUP BY date_trunc('hour', t)
                UNION
                SELECT min(t) FROM snaps
                 WHERE t < now() - INTERVAL {hourly_days} DAY
                 GROUP BY date_trunc('day', t)
            )
            DELETE FROM "{table}" WHERE "{time_col}" NOT IN (SELECT t FROM keep)
            '''
        )
        after = self.con.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
        return before - after

    def apply_retention(self, table: str, days: int, time_col: str = SYNCED_AT) -> int:
        if not self._table_exists(table) or time_col not in self._columns(table):
            return 0
        before = self.con.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
        self.con.execute(
            f'DELETE FROM "{table}" WHERE "{time_col}" < now() - INTERVAL {int(days)} DAY'
        )
        after = self.con.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
        return before - after


# ----------------------------------------------------------------------------- #
# 3) Job model + engine
# ----------------------------------------------------------------------------- #
@dataclass
class Job:
    name: str
    mode: str                       # snapshot | incremental | upsert
    target_table: str
    base_sql: str                   # SELECT ... (no ORDER BY / LIMIT; engine adds them)
    key_col: str                    # monotonically increasing key for keyset paging
    key_type: str = "int"
    chunk_size: int = 50000
    watermark_column: Optional[str] = None      # incremental/upsert
    primary_key: List[str] = field(default_factory=list)  # upsert
    history_table: Optional[str] = None          # upsert
    retention_days: Optional[int] = None
    enabled: bool = True
    dataset: Optional[Dict[str, Any]] = None     # mode superset_dataset (Chart Data API)
    # snapshot mode only: how long full-resolution snapshots are kept before
    # being thinned to hourly, then daily. See DuckDBSink.thin_snapshots.
    snapshot_retention: Dict[str, Any] = field(default_factory=dict)
    # Master/dimension data barely changes, so re-pulling it on every pass is
    # mostly wasted network and CPU. 0 = run on every pass.
    min_interval_seconds: int = 0


class SyncEngine:
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.duckdb_path = config["duckdb_path"]
        self.jobs = [self._parse_job(j) for j in config["jobs"]]
        self._client: Optional[Any] = None
        self.results: List[Dict[str, Any]] = []
        perf = config.get("performance", {}) or {}
        self.lookback_minutes = int(perf.get("lookback_minutes", 10))
        # Paging is driven by job.chunk_size and superset.server_row_cap; the
        # former max_batch_size / concurrency / adaptive_batch / max_retries
        # settings were read here and never used by anything.
        self.progress: Dict[str, Any] = {}

    def _connect(self, read_only: bool = False) -> "duckdb.DuckDBPyConnection":
        """Open DuckDB with a small, explicit VPS resource envelope."""
        perf = self.config.get("performance", {}) or {}
        threads = max(1, min(8, int(perf.get("duckdb_threads", 2))))
        memory_limit = str(perf.get("duckdb_memory_limit", "384MB")).upper()
        if not re.fullmatch(r"\d+(?:MB|GB)", memory_limit):
            memory_limit = "384MB"
        storage_version = str(perf.get("duckdb_storage_version", "v1.3.0"))
        if not re.fullmatch(r"v\d+\.\d+\.\d+", storage_version):
            storage_version = "v1.3.0"
        return duckdb.connect(
            self.duckdb_path,
            read_only=read_only,
            config={
                "threads": str(threads),
                "memory_limit": memory_limit,
                "preserve_insertion_order": "false",
                "storage_compatibility_version": storage_version,
                "temp_directory": os.path.join(
                    tempfile.gettempdir(), f"wiom-duckdb-{os.getpid()}"
                ),
            },
        )

    @staticmethod
    def _is_database_lock_error(error: Exception) -> bool:
        message = str(error).lower()
        return (
            "being used by another process" in message
            or "could not set lock" in message
            or "conflicting lock" in message
            or ("cannot open file" in message and ("lock" in message or "process" in message))
        )

    @contextmanager
    def _writer_connection(self, wait_seconds: float = 45.0):
        """Drain Node readers before opening the short DuckDB write window.

        DuckDB does not support a Python writer and Node readers in separate
        processes. On Windows the OS lock is strict, so retries alone can keep
        colliding with the Settings status poll. A tiny intent file makes new
        web reads wait while this method lets any in-flight reader finish.
        Network extraction remains outside this context.
        """
        intent_path = self.duckdb_path + ".write-intent"
        _write_json_atomic(intent_path, {
            "pid": os.getpid(),
            "created_at": now_utc().isoformat(),
        })
        con: Optional[duckdb.DuckDBPyConnection] = None
        deadline = time.monotonic() + max(1.0, wait_seconds)
        delay = 0.10
        try:
            while True:
                try:
                    con = self._connect()
                    break
                except Exception as error:  # noqa: BLE001
                    if not self._is_database_lock_error(error) or time.monotonic() >= deadline:
                        raise
                    self.progress = {
                        **self.progress,
                        "phase": "waiting_for_database",
                    }
                    log.info("menunggu pembaca dashboard melepas DuckDB (%.1f dtk)", delay)
                    time.sleep(delay)
                    delay = min(0.50, delay * 1.5)
            yield con
        finally:
            if con is not None:
                con.close()
            marker = _read_json(intent_path)
            if not marker or int(marker.get("pid") or 0) == os.getpid():
                try:
                    os.remove(intent_path)
                except FileNotFoundError:
                    pass

    def _read_job_state(self, job_name: str) -> tuple[Dict[str, Any], Optional[float]]:
        """Read the cursor and last-run age without opening a write connection."""
        con = self._connect(read_only=True)
        try:
            row = con.execute(
                "SELECT watermark, key_max, updated_at FROM _sync_state WHERE job = ?",
                [job_name],
            ).fetchone()
        finally:
            con.close()
        if not row:
            return {"watermark": None, "key_max": None}, None
        age = None
        if row[2] is not None:
            last = row[2]
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
            age = max(0.0, (now_utc() - last).total_seconds())
        return {"watermark": row[0], "key_max": row[1]}, age

    @staticmethod
    def _parse_job(j: Dict[str, Any]) -> Job:
        return Job(
            name=j["name"],
            mode=j["mode"],
            target_table=j["target_table"],
            base_sql=j["base_sql"],
            key_col=j["key_col"],
            key_type=j.get("key_type", "int"),
            chunk_size=j.get("chunk_size", 50000),
            watermark_column=j.get("watermark_column"),
            primary_key=j.get("primary_key", []),
            history_table=j.get("history_table"),
            retention_days=j.get("retention_days"),
            enabled=j.get("enabled", True),
            dataset=j.get("dataset"),
            snapshot_retention=j.get("snapshot_retention") or {},
            min_interval_seconds=int(j.get("min_interval_seconds") or 0),
        )

    @property
    def client(self) -> Any:
        if self._client is None:
            source = self.config.get("source", {}) or {}
            stype = source.get("type", "superset")
            if stype in ("superset_dataset", "dataset"):
                log.info("Sumber data: Superset Chart Data API (dataset, TANPA SQL Lab)")
                self._client = SupersetDatasetClient(self.config["superset"])
            elif stype == "clickhouse":
                log.info("Sumber data: ClickHouse HTTP (langsung, tanpa Superset)")
                self._client = ClickHouseClient(source["clickhouse"])
            elif stype == "superset":
                self._client = SupersetClient(self.config["superset"])
            else:
                raise ValueError(f"source.type tidak dikenal: {stype}")
        return self._client

    LOCK_STALE_SEC = 3600  # lock tanpa pemilik yang bisa diverifikasi > 1 jam = basi

    @contextmanager
    def _lock(self):
        """Single-writer lock DuckDB — SELF-HEALING: lock dari proses yang sudah MATI
        (crash / terminal ditutup) diambil alih otomatis; pemegang hidup dihormati."""
        lock_path = self.duckdb_path + ".lock"

        def acquire() -> int:
            f = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_RDWR)
            os.write(
                f,
                (f"{os.getpid()}|{int(time.time())}|"
                 f"{process_start_token(os.getpid()) or ''}").encode(),
            )
            return f

        fd = None
        try:
            try:
                fd = acquire()
            except FileExistsError:
                pid, age, start_token = read_lock_file(lock_path)
                alive = lock_owner_alive(pid, start_token)
                stale = alive is False or (alive is None and age is not None
                                           and age > self.LOCK_STALE_SEC)
                if stale:
                    log.warning("Lock basi terdeteksi (pid=%s%s%s) — diambil alih otomatis.",
                                pid or "?",
                                " sudah MATI" if alive is False else "",
                                f", umur {int(age)} dtk" if age is not None else "")
                    try:
                        os.remove(lock_path)
                    except OSError:
                        pass
                    fd = acquire()
                else:
                    raise RuntimeError(
                        f"Sync lain MASIH memegang lock: {lock_path} "
                        f"(pid={pid or '?'}"
                        f"{f', umur {int(age)} dtk' if age is not None else ''}). "
                        "Tunggu selesai, atau bila yakin tidak ada sync lain jalankan "
                        "--unlock.")
            yield
        finally:
            if fd is not None:
                os.close(fd)
                try:
                    os.remove(lock_path)
                except OSError:
                    pass

    def run_all(self, only: Optional[str] = None,
                fetch_pages=None, force_due: bool = False) -> List[Dict[str, Any]]:
        """
        fetch_pages: injectable extractor for testing. Signature:
            fetch_pages(job, extra_where, start_after) -> Iterable[list[dict]]
        Defaults to the live Superset keyset extractor.
        """
        with self._lock():
            # Schema repair is a short write. Close it before any network work so
            # the web process can keep opening read-only dashboard connections.
            with self._writer_connection() as con:
                bootstrap_schema(con, self.config)
                DuckDBSink(con)

            completed = {
                result["name"]
                for result in self.results
                if result.get("status") in ("OK", "SKIPPED", "UP_TO_DATE")
            }
            for job in self.jobs:
                if only and job.name != only:
                    continue
                # A retry continues after jobs that already committed
                # successfully, preventing duplicate snapshot batches.
                if job.name in completed:
                    continue
                if not job.enabled:
                    log.info("skip %s (disabled)", job.name)
                    self.results.append({
                        "name": job.name, "status": "SKIPPED",
                        "rows_pulled": 0, "rows_written": 0, "duration_ms": 0,
                    })
                    continue
                state, age = self._read_job_state(job.name)
                # Explicit jobs and manual requests always refresh required
                # sources. Only automatic scheduled sweeps honour the longer
                # master-data interval used to save Superset/VPS resources.
                if (not force_due and only != job.name and job.min_interval_seconds
                        and age is not None and age < job.min_interval_seconds):
                    due_in = job.min_interval_seconds - age
                    log.info("skip %s (belum jatuh tempo, %.0f menit lagi)",
                             job.name, due_in / 60)
                    self.results.append({
                        "name": job.name, "status": "UP_TO_DATE",
                        "rows_pulled": 0, "rows_written": 0, "duration_ms": 0,
                        "message": f"belum jatuh tempo ({due_in / 60:.0f} menit lagi)",
                    })
                    continue
                self._run_job(job, state, fetch_pages)
        return list(self.results)

    def _run_job(self, job: Job, state: Dict[str, Any], fetch_pages) -> None:
        started = now_utc()
        extra_where = None
        start_after = None

        if job.mode in ("incremental", "upsert") and job.watermark_column and state["watermark"]:
            wm = state["watermark"]
            # Apply lookback window to catch late-arriving updates
            if self.lookback_minutes > 0:
                try:
                    wm_dt = datetime.fromisoformat(wm.replace("Z", "+00:00"))
                    adjusted = (wm_dt - timedelta(minutes=self.lookback_minutes)).isoformat()
                    q = SupersetClient._quote(adjusted, "timestamp")
                    extra_where = f"_t.{job.watermark_column} > {q}"
                    log.info("[%s] incremental from watermark %s (lookback %d min -> %s)",
                             job.name, wm, self.lookback_minutes, adjusted)
                except (ValueError, TypeError):
                    q = SupersetClient._quote(wm, "timestamp")
                    extra_where = f"_t.{job.watermark_column} > {q}"
                    log.info("[%s] incremental from watermark %s", job.name, wm)
            else:
                q = SupersetClient._quote(wm, "timestamp")
                extra_where = f"_t.{job.watermark_column} > {q}"
                log.info("[%s] incremental from watermark %s", job.name, wm)
        if job.mode == "snapshot":
            log.info("[%s] full snapshot pull", job.name)

        if fetch_pages:
            pages = fetch_pages(job, extra_where, start_after)
        elif isinstance(self.client, SupersetDatasetClient):
            wm = state["watermark"] if (job.mode in ("incremental", "upsert")
                                        and job.watermark_column) else None
            pages = self.client.dataset_pages(job, watermark=wm)
        else:
            pages = self.client.keyset_pages(
                base_sql=job.base_sql, key_col=job.key_col, key_type=job.key_type,
                chunk_size=job.chunk_size, start_after=start_after, extra_where=extra_where,
            )

        pulled = written = 0
        batch_idx = 0
        max_watermark = state["watermark"]
        max_key = state["key_max"]
        run_started = time.time()
        db_dir = os.path.dirname(os.path.abspath(self.duckdb_path))
        os.makedirs(db_dir, exist_ok=True)
        stage_fd, stage_path = tempfile.mkstemp(
            prefix=".superset-sync-extract-", suffix=".jsonl", dir=db_dir,
        )
        os.close(stage_fd)
        con: Optional[duckdb.DuckDBPyConnection] = None
        sink: Optional[DuckDBSink] = None
        transaction_open = False
        writer_context = None
        writer_active = False
        try:
            # Network extraction is staged first. This is intentionally outside
            # the DuckDB write connection: a slow Superset response no longer
            # makes the dashboard unavailable for the whole download window.
            with open(stage_path, "w", encoding="utf-8", newline="\n") as staged:
                for rows in pages:
                    if pd is None:
                        raise RuntimeError("pandas is required for real sync (pip install pandas)")
                    if not rows:
                        continue
                    df = pd.DataFrame(rows)
                    pulled += len(df)
                    batch_idx += 1
                    for row in rows:
                        staged.write(json.dumps(
                            row, ensure_ascii=False, default=str, separators=(",", ":"),
                        ))
                        staged.write("\n")

                    if job.watermark_column and job.watermark_column in df.columns:
                        wm = str(df[job.watermark_column].max())
                        max_watermark = wm if not max_watermark else max(max_watermark, wm)
                    if job.key_col in df.columns:
                        max_key = str(df[job.key_col].max())

                    elapsed = time.time() - run_started
                    throughput = round(pulled / elapsed, 1) if elapsed > 0 else 0
                    self.progress = {
                        "job": job.name,
                        "phase": "extracting",
                        "current_batch": batch_idx,
                        "rows_pulled": pulled,
                        "rows_written": 0,
                        "cursor": max_key or max_watermark,
                        "throughput_rows_per_sec": throughput,
                    }
                    log.info("[%s] unduh batch %d: %d rows (total %d, %.0f rows/s)",
                             job.name, batch_idx, len(df), pulled, throughput)

            # Only the local write phase owns DuckDB. All changes remain one
            # transaction, so a failed batch cannot leave a partial snapshot.
            writer_context = self._writer_connection()
            con = writer_context.__enter__()
            writer_active = True
            sink = DuckDBSink(con)
            sink.con.execute("BEGIN TRANSACTION")
            transaction_open = True
            batch_idx = 0
            buffer: List[Dict[str, Any]] = []

            def write_batch(rows: List[Dict[str, Any]]) -> None:
                nonlocal written, batch_idx
                if not rows:
                    return
                frame = pd.DataFrame(rows)
                batch_idx += 1
                if job.mode == "snapshot":
                    written += sink.append_snapshot(job.target_table, frame, started)
                elif job.mode == "incremental":
                    written += sink.append_incremental(job.target_table, frame, started)
                elif job.mode == "upsert":
                    written += sink.upsert(job.target_table, frame, job.primary_key,
                                           started, job.history_table)
                else:
                    raise ValueError(f"Unknown mode {job.mode}")
                self.progress = {
                    "job": job.name,
                    "phase": "writing",
                    "current_batch": batch_idx,
                    "rows_pulled": pulled,
                    "rows_written": written,
                    "cursor": max_key or max_watermark,
                }
                log.info("[%s] tulis batch %d: %d rows (total %d)",
                         job.name, batch_idx, len(frame), written)

            with open(stage_path, "r", encoding="utf-8") as staged:
                for line in staged:
                    buffer.append(json.loads(line))
                    if len(buffer) >= job.chunk_size:
                        write_batch(buffer)
                        buffer = []
                write_batch(buffer)

            # snapshot mode advances no watermark (it re-reads current state each run)
            if job.mode != "snapshot":
                sink.set_state(job.name, max_watermark, max_key)
            else:
                # Still record the run so min_interval_seconds can be honoured.
                sink.mark_run(job.name)

            purged = 0
            if job.retention_days:
                purged = sink.apply_retention(job.target_table, job.retention_days)
            if job.mode == "snapshot":
                # Only snapshot tables have whole-copy duplicates to thin; for
                # upsert/incremental _synced_at marks a row edit, not a copy.
                purged += sink.thin_snapshots(job.target_table, job.snapshot_retention)

            sink.audit(job=job.name, mode=job.mode, started_at=started, finished_at=now_utc(),
                       rows_pulled=pulled, rows_written=written, watermark=max_watermark,
                       status="OK", message=f"purged={purged}")
            sink.con.execute("COMMIT")
            transaction_open = False
            self.results.append({
                "name": job.name, "status": "OK",
                "rows_pulled": pulled, "rows_written": written,
                "duration_ms": int((now_utc() - started).total_seconds() * 1000),
                "message": f"purged={purged}",
            })
            log.info("[%s] done: pulled=%d written=%d watermark=%s purged=%d",
                     job.name, pulled, written, max_watermark, purged)
        except Exception as e:  # noqa: BLE001
            if transaction_open and sink is not None:
                try:
                    sink.con.execute("ROLLBACK")
                except Exception:  # noqa: BLE001
                    log.exception("[%s] rollback gagal", job.name)
            # Record the failed attempt after rollback so the audit survives.
            try:
                if con is None:
                    raise RuntimeError("writer DuckDB belum berhasil dibuka; audit tersedia di status runtime")
                audit_con = con
                audit_sink = DuckDBSink(audit_con)
                audit_sink.audit(job=job.name, mode=job.mode, started_at=started,
                                 finished_at=now_utc(), rows_pulled=pulled,
                                 rows_written=0, watermark=max_watermark,
                                 status="ERROR", message=str(e)[:500])
            except Exception:  # noqa: BLE001
                log.exception("[%s] gagal menulis audit error", job.name)
            self.results.append({
                "name": job.name, "status": "ERROR",
                "rows_pulled": pulled, "rows_written": 0,
                "duration_ms": int((now_utc() - started).total_seconds() * 1000),
                "message": str(e)[:500],
            })
            log.exception("[%s] FAILED: %s", job.name, e)
            raise
        finally:
            if writer_active and writer_context is not None:
                writer_context.__exit__(None, None, None)
            elif con is not None:
                con.close()
            try:
                os.remove(stage_path)
            except FileNotFoundError:
                pass


# ----------------------------------------------------------------------------- #
# 4) CLI
# ----------------------------------------------------------------------------- #

def run_unlock(engine: "SyncEngine") -> None:
    """Hapus lock BASI dengan aman (menolak bila pemegangnya masih hidup)."""
    lock_path = engine.duckdb_path + ".lock"
    if not os.path.exists(lock_path):
        log.info("Tidak ada lock: %s", lock_path)
        return
    pid, age, start_token = read_lock_file(lock_path)
    alive = lock_owner_alive(pid, start_token)
    if alive is True:
        log.error("Proses %s MASIH HIDUP memegang lock — TIDAK dihapus. "
                  "Matikan proses itu dulu (Task Manager / taskkill), atau tunggu selesai.", pid)
        return
    os.remove(lock_path)
    log.info("Lock dihapus: %s (pid=%s%s%s)", lock_path, pid or "?",
             " mati" if alive is False else " tak terverifikasi",
             f", umur {int(age)} dtk" if age is not None else "")


def run_compact(engine: "SyncEngine") -> None:
    """Rewrite the DuckDB file so deleted snapshots actually return disk space.

    DELETE frees blocks for reuse but never shrinks the file, so a database that
    once grew to tens of GB keeps occupying that much on the VPS. Copying into a
    fresh file and swapping it in is the only way to reclaim it.
    """
    src = os.path.abspath(engine.duckdb_path)
    if not os.path.isfile(src):
        raise RuntimeError(f"Database tidak ditemukan: {src}")
    tmp = f"{src}.compact-{os.getpid()}"
    for leftover in (tmp, f"{tmp}.wal"):
        if os.path.exists(leftover):
            os.remove(leftover)
    before = os.path.getsize(src)
    with engine._lock():  # noqa: SLF001 — same single-writer guarantee as a sync
        con = engine._connect()  # noqa: SLF001
        try:
            bootstrap_schema(con, engine.config)
            con.execute("CHECKPOINT")
            # The attached name of the opened file is its basename without the
            # extension; COPY FROM DATABASE needs it explicitly.
            source_alias = con.execute(
                "SELECT database_name FROM duckdb_databases() "
                "WHERE NOT internal AND database_name <> 'compacted' LIMIT 1"
            ).fetchone()[0]
            perf = engine.config.get("performance", {}) or {}
            storage_version = str(perf.get("duckdb_storage_version", "v1.3.0"))
            if not re.fullmatch(r"v\d+\.\d+\.\d+", storage_version):
                storage_version = "v1.3.0"
            escaped_tmp = tmp.replace("'", "''")
            con.execute(
                f"ATTACH '{escaped_tmp}' AS compacted "
                f"(STORAGE_VERSION '{storage_version}')"
            )
            con.execute(f'COPY FROM DATABASE "{source_alias}" TO compacted')
            con.execute("DETACH compacted")
        finally:
            con.close()
        os.replace(tmp, src)
        for stale in (f"{src}.wal", f"{tmp}.wal"):
            if os.path.exists(stale):
                os.remove(stale)
    after = os.path.getsize(src)
    log.info("compact selesai: %.1f MB -> %.1f MB (hemat %.1f MB)",
             before / 1048576, after / 1048576, (before - after) / 1048576)


def run_columns(engine: "SyncEngine") -> None:
    """Cetak skema kolom ASLI tiap dataset di config — untuk menyelaraskan mapping."""
    client = engine.client
    if not isinstance(client, SupersetDatasetClient):
        log.error("--columns hanya utk source superset_dataset")
        return
    for job in engine.jobs:
        d = job.dataset or {}
        ds_id = d.get("id")
        if not (isinstance(ds_id, int) or str(ds_id).isdigit()):
            log.warning("SKIP %s — dataset.id belum angka (%r)", job.name, ds_id)
            continue
        try:
            cols = client.dataset_columns(int(ds_id))
            cfg_cols = set((d.get("columns") or {}).keys())
            log.info("== %s (dataset %s) — %d kolom asli ==", job.name, ds_id, len(cols))
            for c in sorted(cols):
                mark = "✓ dipakai" if c in cfg_cols else "  "
                log.info("   %-32s %s", c, mark)
            missing = sorted(cfg_cols - set(cols))
            if missing:
                log.warning("   config meminta kolom yang TIDAK ADA: %s", missing)
        except Exception as e:  # noqa: BLE001
            log.error("GAGAL introspeksi %s (dataset %s) → %s", job.name, ds_id, str(e)[:180])


def run_doctor(engine: "SyncEngine") -> None:
    """Diagnosa koneksi & auth tanpa menulis data. Pakai saat sync error 401/502/524."""
    cfg = engine.config
    stype = (cfg.get("source", {}) or {}).get("type", "superset")
    log.info("=== WIOM SYNC DOCTOR — source=%s ===", stype)
    client = engine.client
    if stype == "clickhouse":
        try:
            client._execute("SELECT 1 AS ok")
            log.info("OK   ClickHouse menjawab SELECT 1")
        except Exception as e:  # noqa: BLE001
            log.error("GAGAL ClickHouse: %s", str(e)[:200])
        return

    base = client.base
    # 1) health — jaringan/gateway
    try:
        r = client._http("GET", f"{base}/health", tries=1, timeout=min(client.timeout, 30))
        log.info("OK   GET /health (%d) — jaringan & gateway hidup", r.status_code)
    except Exception as e:  # noqa: BLE001
        log.error("GAGAL GET /health → %s", str(e)[:200])
        log.error("     → 502/524 = gateway/Cloudflare: origin lambat atau request diblokir; "
                  "coba lagi / VPN kantor / jam sepi.")
    # 2) sesi WEB — apakah cookie diterima utk halaman biasa?
    web_ok = None
    try:
        rw = client.s.get(f"{base}/", timeout=min(client.timeout, 30), allow_redirects=True)
        web_ok = "/login" not in rw.url
        if web_ok:
            log.info("OK   GET / (web) — sesi web diterima (%s)", rw.url)
        else:
            log.error("INFO GET / (web) → diarahkan ke %s — cookie TIDAK berlaku bahkan utk web.",
                      rw.url)
    except Exception as e:  # noqa: BLE001
        log.warning("SKIP cek web: %s", str(e)[:140])
    # 2b) kualitas cookie session (tanpa secret): usia + utuh/korup + _user_id
    sess = next((c.value for c in client.s.cookies if c.name == "session"), None)
    if sess:
        payload, issued, err = decode_flask_session(sess)
        age = f"{(now_utc() - issued).days} hari" if issued else "?"
        if payload is None:
            log.error("INFO cookie 'session': KORUP/TERPOTONG saat disalin (%s) — usia %s. "
                      "Salin ulang: DevTools → Application → Cookies → klik nilai → "
                      "Ctrl+A, Ctrl+C (jangan seleksi manual).", (err or "")[:80], age)
        else:
            uid = payload.get("_user_id") or payload.get("user_id")
            log.info("OK   cookie 'session' utuh — dibuat %s (usia %s), _user_id: %s",
                     issued.date() if issued else "?", age, uid if uid else "TIDAK ADA (anonim!)")
            if not uid:
                log.error("     → cookie ANONIM: disalin sebelum login / dari tab lain. "
                          "Login dulu di browser, refresh, baru salin ulang.")
    else:
        log.info("INFO tidak ada cookie 'session' di config (mode login/bearer?)")
    # 3) identitas API — tes auth yang sesungguhnya utk /api/v1/*
    try:
        r = client._http("GET", f"{base}/api/v1/me/", tries=1, timeout=min(client.timeout, 30))
        j = r.json().get("result", {})
        log.info("OK   GET /api/v1/me/ — login sebagai: %s",
                 j.get("username") or j.get("email") or "?")
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        log.error("GAGAL GET /api/v1/me/ → %s", msg[:200])
        if "Missing Authorization Header" in msg:
            log.error("     → API instance ini MENUNTUT Bearer token (flask-jwt), sesi cookie "
                      "tidak dipakai utk /api/v1/*.")
            log.error("     SOLUSI #1 (dianjurkan): superset.auth.mode='login' + username & "
                      "password Superset (provider 'db', bila gagal coba 'ldap') — script "
                      "menukar jadi Bearer + login-ulang otomatis saat kedaluwarsa.")
            log.error("     SOLUSI #2: bila login web via Google/SSO (tanpa password Superset): "
                      "auth.cookie_header = SELURUH nilai header Cookie dari DevTools → Network "
                      "→ klik request api/v1 mana pun → Request Headers → Cookie (termasuk "
                      "cookie proxy spt CF_Authorization). %s",
                      "Cookie web valid — tinggal lengkapi cookie yang belum tersalin."
                      if web_ok else "Cookie web pun ditolak — salin ulang seluruhnya.")
        else:
            log.error("     → cookie/token invalid atau kedaluwarsa — perbarui kredensial "
                      "lalu jalankan --doctor lagi.")
    # 3) CSRF
    log.info("%s CSRF token", "OK  " if getattr(client, "csrf", None) else "INFO tanpa")
    if not getattr(client, "csrf", None):
        log.info("     → POST chart/data mungkin ditolak; fallback GET chart_id akan dipakai "
                 "otomatis bila diisi.")
    # 4) probe tiap job aktif
    for job in engine.jobs:
        if not job.enabled or not job.dataset:
            continue
        d = job.dataset
        ds_id = d.get("id")
        if not (isinstance(ds_id, int) or str(ds_id).isdigit()):
            log.warning("SKIP %s — dataset.id belum diisi angka (%r)", job.name, ds_id)
            continue
        raw_cols = list((d.get("columns") or {}).keys())
        pruned_note = ""
        try:  # mirror perilaku sync: pangkas ke skema asli sebelum probe
            real = set(client.dataset_columns(int(ds_id)))
            gone = [c for c in raw_cols if c not in real]
            if gone:
                raw_cols = [c for c in raw_cols if c in real]
                pruned_note = f" (terpangkas: {len(gone)} kolom → {gone})"
            bad_metric = [mt["column"] for mt in d.get("metrics", [])
                          if mt["column"] not in real]
            if bad_metric:
                log.error("GAGAL dataset %s (%s) — kolom metric %s tidak ada. Tersedia: %s",
                          ds_id, job.name, bad_metric, sorted(real))
                continue
        except Exception as ie:  # noqa: BLE001
            log.info("     introspeksi %s gagal (%s) — probe pakai kolom config",
                     ds_id, str(ie)[:90])
        d = {**d, "_raw_cols_effective": list(raw_cols)}
        mets = [SupersetDatasetClient._metric_expr(m) for m in d.get("metrics", [])]
        ob_src = [d["key"]] if (d.get("page") == "keyset" and d.get("key")) else \
                 (d.get("orderby") or raw_cols[:1])
        ob = [[c, True] for c in ob_src if c in raw_cols] or [[raw_cols[0], True]]
        try:
            rows = client._chart_data(int(ds_id), raw_cols, mets, list(d.get("filters", [])), ob, 1, 0)
            cols = list(rows[0].keys()) if rows else []
            log.info("OK   POST dataset %s (%s)%s — contoh kolom: %s", ds_id, job.name,
                     pruned_note, ", ".join(cols[:6]) or "(0 baris)")
            missing = [c for c in raw_cols if rows and c not in rows[0]]
            if missing:
                log.warning("     kolom RAW tidak ditemukan di respons: %s — cek nama di panel "
                            "Columns dataset", ", ".join(missing[:8]))
        except Exception as e:  # noqa: BLE001
            log.error("GAGAL POST dataset %s (%s) → %s", ds_id, job.name, str(e)[:220])
            if "Columns missing" in str(e) and isinstance(client, SupersetDatasetClient):
                try:
                    log.info("     kolom ASLI dataset %s: %s", ds_id,
                             sorted(client.dataset_columns(int(ds_id))))
                except Exception:  # noqa: BLE001
                    pass
            if isinstance(client, SupersetDatasetClient):
                try:
                    rows = client.legacy_rows({**d, "id": int(ds_id)},
                                              list(d.get("filters", [])), 1)
                    log.info("OK   LEGACY explore_json dataset %s — %d baris contoh "
                             "(sync akan otomatis memakai jalur ini)", ds_id, len(rows))
                except Exception as le:  # noqa: BLE001
                    log.error("GAGAL LEGACY dataset %s → %s", ds_id, str(le)[:200])
        cid = d.get("chart_id")
        if isinstance(cid, int) or str(cid).isdigit():
            try:
                fs, wh, tr, gr, chart_rl = client.chart_saved_query(int(cid))
                log.info("     filter TERSIMPAN chart %s yang akan diwarisi → %s%s%s "
                         "(filter dari FILTER BAR dashboard tidak ikut — pindahkan ke chart "
                         "lalu Save bila perlu)", cid, fs if fs else "—",
                         f" | WHERE {wh}" if wh else "",
                         f" | time_range={tr} ({gr})" if tr else "")
            except Exception as e:  # noqa: BLE001
                log.warning("     gagal membaca filter chart %s: %s", cid, str(e)[:150])
            try:
                rows = client.chart_get_rows(int(cid))
                log.info("OK   GET chart %s — %d baris", cid, len(rows))
                if chart_rl and len(rows) >= int(chart_rl):
                    log.warning("     %d baris = Row Limit chart (%s) — data kemungkinan "
                                "TERPOTONG! Naikkan Row Limit chart lalu Save.",
                                len(rows), chart_rl)
            except Exception as e:  # noqa: BLE001
                log.error("GAGAL GET chart %s → %s", cid, str(e)[:220])
    log.info("=== DOCTOR selesai ===")


def run_managed_daemon(config_path: str, only_job: Optional[str], default_retries: int) -> None:
    """Reload settings every pass and bridge web Settings via small control files."""
    initial_config = load_runtime_config(config_path)
    initial_control = initial_config.get("control", {}) or {}
    acquire_daemon_lock(
        initial_control.get("daemon_lock_file", "db/.superset-sync-daemon.lock")
    )
    service_started_at = now_utc().isoformat()
    next_due = 0.0
    last_request_id: Optional[str] = None
    heartbeat_state: Dict[str, Any] = {
        # Seed from the configured paths, not the defaults: the heartbeat thread
        # starts before the control loop's first config read, so a deployment
        # with custom control files would otherwise emit its first heartbeats
        # into a stray db/.superset-sync-heartbeat.json nobody watches.
        "path": initial_control.get("heartbeat_file", "db/.superset-sync-heartbeat.json"),
        "ready": False,
        "error": None,
        "status_path": initial_control.get("status_file", "db/.superset-sync-status.json"),
        "common": {},
        "active": False,
    }
    active_engine_ref: List[Optional[SyncEngine]] = [None]
    heartbeat_wakeup = threading.Event()

    def heartbeat_loop() -> None:
        while True:
            try:
                _write_json_atomic(str(heartbeat_state["path"]), {
                    "pid": os.getpid(),
                    "service_started_at": service_started_at,
                    "heartbeat_at": now_utc().isoformat(),
                    "ready": bool(heartbeat_state["ready"]),
                    "error": heartbeat_state.get("error"),
                })
                # Also update status file with real-time progress if sync is running
                if (heartbeat_state.get("active")
                        and active_engine_ref[0]
                        and active_engine_ref[0].progress):
                    prog = active_engine_ref[0].progress
                    try:
                        _write_json_atomic(str(heartbeat_state["status_path"]), {
                            **heartbeat_state.get("common", {}),
                            "state": "running",
                            "finished_at": None,
                            "next_run_at": None,
                            "phase": prog.get("phase"),
                            "current_batch": prog.get("current_batch"),
                            "cursor": prog.get("cursor"),
                            "throughput_rows_per_sec": prog.get("throughput_rows_per_sec"),
                            "rows_pulled": prog.get("rows_pulled", 0),
                            "rows_written": prog.get("rows_written", 0),
                            "updated_at": now_utc().isoformat(),
                        })
                    except Exception:  # noqa: BLE001
                        pass  # Don't let progress writing crash the heartbeat
            except Exception as heartbeat_error:  # noqa: BLE001
                log.warning("heartbeat worker gagal: %s", heartbeat_error)
            heartbeat_wakeup.wait(5)
            heartbeat_wakeup.clear()

    threading.Thread(
        target=heartbeat_loop,
        name="wiom-sync-heartbeat",
        daemon=True,
    ).start()
    log.info("managed sync daemon started — configuration reload is active")

    def run_with_retry(active_engine: SyncEngine, retries: int,
                       force_due: bool = False) -> List[Dict[str, Any]]:
        delay = 5
        for attempt in range(1, retries + 1):
            try:
                return active_engine.run_all(only=only_job, force_due=force_due)
            except Exception as exc:  # noqa: BLE001
                log.warning("pass failed (attempt %d/%d): %s", attempt, retries, exc)
                if attempt >= retries:
                    raise
                # Keep successful committed jobs, discard the transient error,
                # and create a fresh authenticated client for the next attempt.
                active_engine.results = [
                    result
                    for result in active_engine.results
                    if result.get("status") in ("OK", "SKIPPED", "UP_TO_DATE")
                ]
                active_engine._client = None
                time.sleep(delay)
                delay = min(delay * 2, 120)
        return []

    while True:
        try:
            config = load_runtime_config(config_path)
            schedule = config.get("schedule", {}) or {}
            control = config.get("control", {}) or {}
            status_file = control.get("status_file", "db/.superset-sync-status.json")
            request_file = control.get("request_file", "db/.superset-sync-request.json")
            heartbeat_state["path"] = control.get(
                "heartbeat_file",
                "db/.superset-sync-heartbeat.json",
            )
            heartbeat_state["ready"] = True
            heartbeat_state["error"] = None
            heartbeat_wakeup.set()
            interval = max(15, int(schedule.get("interval_seconds", 300)))
            enabled = bool(schedule.get("enabled", True))
            request = _read_json(request_file)
            request_id = str(request.get("request_id")) if request and request.get("request_id") else None
            manual = bool(request_id and request_id != last_request_id)

            if not enabled:
                _write_json_atomic(status_file, {
                    "state": "paused",
                    "service_started_at": service_started_at,
                    "next_run_at": None,
                    "updated_at": now_utc().isoformat(),
                })
                time.sleep(2)
                continue

            if not manual and time.time() < next_due:
                time.sleep(min(2, max(0.2, next_due - time.time())))
                continue

            trigger = "manual" if manual else "schedule"
            started_at = now_utc()
            active_engine = SyncEngine(config)
            common = {
                "service_started_at": service_started_at,
                "started_at": started_at.isoformat(),
                "trigger": trigger,
                "request_id": request_id,
                "requested_by": request.get("requested_by") if request else None,
            }
            heartbeat_state["status_path"] = status_file
            heartbeat_state["common"] = common
            heartbeat_state["active"] = True
            active_engine_ref[0] = active_engine
            heartbeat_wakeup.set()
            _write_json_atomic(status_file, {
                **common,
                "state": "running",
                "finished_at": None,
                "next_run_at": None,
                "updated_at": started_at.isoformat(),
            })
            try:
                results = run_with_retry(
                    active_engine,
                    max(1, int(schedule.get("retry_count", default_retries))),
                    force_due=manual,
                )
                finished_at = now_utc()
                next_due = time.time() + interval
                _write_json_atomic(status_file, {
                    **common,
                    "state": "succeeded",
                    "finished_at": finished_at.isoformat(),
                    "next_run_at": _iso_after(interval),
                    "duration_ms": int((finished_at - started_at).total_seconds() * 1000),
                    "rows_pulled": sum(int(row.get("rows_pulled", 0)) for row in results),
                    "rows_written": sum(int(row.get("rows_written", 0)) for row in results),
                    "jobs": results,
                    "error": None,
                    "updated_at": finished_at.isoformat(),
                })
            except Exception as exc:  # noqa: BLE001
                finished_at = now_utc()
                next_due = time.time() + interval
                error_category = SupersetClient.classify_error(exc)
                _write_json_atomic(status_file, {
                    **common,
                    "state": "failed",
                    "finished_at": finished_at.isoformat(),
                    "next_run_at": _iso_after(interval),
                    "duration_ms": int((finished_at - started_at).total_seconds() * 1000),
                    "rows_pulled": sum(int(row.get("rows_pulled", 0)) for row in active_engine.results),
                    "rows_written": sum(int(row.get("rows_written", 0)) for row in active_engine.results),
                    "jobs": active_engine.results,
                    "error": str(exc)[:500],
                    "error_category": error_category,
                    "updated_at": finished_at.isoformat(),
                })
                log.error("managed pass failed: %s (category=%s)", exc, error_category)
            finally:
                heartbeat_state["active"] = False
                active_engine_ref[0] = None
                if manual and request_id:
                    last_request_id = request_id
                    latest = _read_json(request_file)
                    if latest and str(latest.get("request_id")) == request_id:
                        try:
                            os.remove(request_file)
                        except OSError:
                            pass
        except KeyboardInterrupt:
            raise
        except Exception as daemon_error:  # noqa: BLE001
            heartbeat_state["ready"] = False
            heartbeat_state["error"] = str(daemon_error)[:500]
            heartbeat_wakeup.set()
            log.exception("daemon control error: %s", daemon_error)
            time.sleep(3)


def run_runtime_check(config: Dict[str, Any], require_auth: bool = False) -> None:
    """Validate local runtime requirements without contacting Superset."""
    # SSL must be importable — slim images can miss libssl3 at runtime, which
    # breaks every HTTPS request with "Can't connect to HTTPS URL because the
    # SSL module is not available". Catch it here so the failure is explicit.
    try:
        import ssl  # noqa: F401
    except ImportError as ssl_err:  # noqa: BLE001
        raise RuntimeError(
            "Modul SSL Python tidak tersedia — HTTPS ke Superset tidak akan jalan. "
            "Pasang libssl3/openssl pada image (lihat Dockerfile)."
        ) from ssl_err
    duckdb_path = os.path.abspath(str(config.get("duckdb_path") or ""))
    if not duckdb_path:
        raise ValueError("duckdb_path belum dikonfigurasi.")
    parent = os.path.dirname(duckdb_path)
    os.makedirs(parent, exist_ok=True)
    probe = os.path.join(parent, f".superset-sync-write-check-{os.getpid()}")
    try:
        with open(probe, "x", encoding="utf-8") as handle:
            handle.write("ok\n")
    finally:
        try:
            os.remove(probe)
        except FileNotFoundError:
            pass

    superset = config.get("superset", {}) or {}
    base_url = str(superset.get("base_url") or "").strip()
    if not base_url.startswith(("http://", "https://")):
        raise ValueError("superset.base_url harus berupa URL HTTP/HTTPS.")
    auth = superset.get("auth", {}) or {}
    mode = str(auth.get("mode") or "auto")
    has_login = bool(str(auth.get("username") or "").strip()
                     and str(auth.get("password") or "").strip())
    has_cookie = bool(str(auth.get("cookie_header") or "").strip())
    has_bearer = bool(str(auth.get("access_token") or "").strip())
    # Same fault class as the client constructor, so the bootstrap preflight and
    # a real pass report an identical, actionable category.
    if require_auth and mode == "login" and not has_login:
        raise AuthConfigurationError(
            "Mode login membutuhkan username dan password Superset "
            "(SUPERSET_USERNAME + SUPERSET_PASSWORD).")
    if require_auth and mode == "cookie" and not has_cookie:
        raise AuthConfigurationError(
            "Mode cookie membutuhkan cookie Superset. Pada deployment container isi "
            "SUPERSET_COOKIE_HEADER atau SUPERSET_SESSION_COOKIE — file secrets lokal "
            "sengaja tidak ikut ke image.")
    if require_auth and mode == "bearer" and not has_bearer:
        raise AuthConfigurationError(
            "Mode bearer membutuhkan access token Superset (SUPERSET_ACCESS_TOKEN).")
    if require_auth and mode == "auto" and not (has_login or has_cookie or has_bearer):
        raise AuthConfigurationError(
            "Kredensial Superset belum dikonfigurasi. Isi SUPERSET_USERNAME + "
            "SUPERSET_PASSWORD, atau SUPERSET_COOKIE_HEADER, pada environment deployment.")

    jobs = [job for job in (config.get("jobs") or []) if job.get("enabled", True)]
    if not jobs:
        raise ValueError("Tidak ada job Superset aktif.")
    for job in jobs:
        dataset_id = str((job.get("dataset") or {}).get("id") or "")
        if not dataset_id.isdigit():
            raise ValueError(f"Dataset ID job {job.get('name') or '?'} belum valid.")
    log.info(
        "runtime check OK — storage writable, auth %s, %d job aktif",
        "configured" if has_login or has_cookie or has_bearer else "pending",
        len(jobs),
    )


def main() -> None:
    ap = argparse.ArgumentParser(description="Auto live sync: Superset -> DuckDB (with history)")
    ap.add_argument("--config", required=True, help="Path to JSON config")
    ap.add_argument("--job", help="Run a single job by name")
    ap.add_argument("--loop", type=int, metavar="SECONDS",
                    help="Run continuously every N seconds")
    ap.add_argument("--daemon", action="store_true",
                    help="Run managed loop; reload config and accept Settings sync requests")
    ap.add_argument("--retry", type=int, default=3, help="Retries per pass (default 3)")
    ap.add_argument("--doctor", action="store_true",
                    help="Diagnosa koneksi/auth (health, me, CSRF, probe dataset) lalu keluar")
    ap.add_argument("--columns", action="store_true",
                    help="Cetak kolom ASLI tiap dataset di config (utk menyelaraskan mapping)")
    ap.add_argument("--unlock", action="store_true",
                    help="Hapus lock basi db/*.duckdb.lock (menolak bila pemegang masih hidup)")
    ap.add_argument("--compact", action="store_true",
                    help="Tulis ulang file DuckDB agar ruang bekas hapus snapshot kembali")
    ap.add_argument("--check-runtime", action="store_true",
                    help="Validasi dependency/config/storage lokal tanpa menghubungi Superset")
    ap.add_argument("--check-auth", action="store_true",
                    help="Dengan --check-runtime, wajibkan kredensial Superset sudah tersedia")
    args = ap.parse_args()

    config = load_runtime_config(args.config)
    if args.check_runtime:
        run_runtime_check(config, require_auth=args.check_auth)
        return
    engine = SyncEngine(config)

    if args.doctor:
        run_doctor(engine)
        return
    if args.columns:
        run_columns(engine)
        return
    if args.unlock:
        run_unlock(engine)
        return
    if args.compact:
        run_compact(engine)
        return
    if args.daemon:
        run_managed_daemon(args.config, args.job, args.retry)
        return

    def one_pass() -> None:
        delay = 5
        for attempt in range(1, args.retry + 1):
            try:
                engine.run_all(only=args.job)
                return
            except Exception as e:  # noqa: BLE001
                log.warning("pass failed (attempt %d/%d): %s", attempt, args.retry, e)
                if attempt < args.retry:
                    time.sleep(delay)
                    delay = min(delay * 2, 120)
                else:
                    raise

    if args.loop:
        log.info("live sync loop every %ds — Ctrl-C to stop", args.loop)
        while True:
            t0 = time.time()
            try:
                one_pass()
            except Exception:  # noqa: BLE001
                log.error("pass errored; will retry next tick")
            time.sleep(max(1, args.loop - (time.time() - t0)))
    else:
        one_pass()


if __name__ == "__main__":
    main()
