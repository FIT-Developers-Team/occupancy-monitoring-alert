// Kontras tema terang DAN gelap, dihitung — bukan ditaksir.
//
// Sebuah palet dapat terlihat benar dan tetap gagal terbaca. Empat kegagalan
// nyata ditemukan dengan menghitung rasionya, dan tidak satu pun kentara dengan
// mata:
//
//  - `--text-muted` terang hanya 4,23:1 di atas permukaan tersunken. Teks
//    sekunder ada di hampir setiap baris aplikasi ini.
//  - Putih di atas `--accent` hanya 3,64:1 di tema terang dan 2,76:1 di tema
//    GELAP — tombol primer, elemen yang paling sering ditekan. Tema gelap justru
//    lebih buruk, karena aksennya di sana memang lebih terang.
//  - `.btn-danger` memakai #DC2626 apa adanya di kedua tema: 3,59:1 di gelap.
//  - Teks sel heatmap Breach: putih 3,76:1 di tema gelap.
//
// Uji ini membaca nilai token langsung dari globals.css, sehingga palet tidak
// dapat digeser tanpa rasionya ikut diperiksa.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

/** Token warna di dalam satu blok selector. */
function tokensOf(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `blok ${selector} harus ada`);
  const end = css.indexOf("\n}", start);
  const out = {};
  for (const match of css.slice(start, end).matchAll(/(--[\w-]+):\s*(#[0-9A-Fa-f]{3,8})/g)) {
    out[match[1]] = match[2];
  }
  return out;
}

const light = tokensOf(":root");
const dark = tokensOf(".dark");

function channels(value) {
  let hex = value.replace("#", "");
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function luminance(value) {
  const [r, g, b] = channels(value).map((raw) => {
    const channel = raw / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** WCAG AA: 4.5 untuk teks normal, 3.0 untuk elemen non-teks & teks besar. */
const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

function check(theme, tokens, fg, bg, minimum, label) {
  const foreground = tokens[fg] ?? fg;
  const background = tokens[bg] ?? bg;
  const ratio = contrast(foreground, background);
  assert.ok(
    ratio >= minimum,
    `${theme} · ${label}: ${foreground} di atas ${background} = ${ratio.toFixed(2)}:1, `
      + `minimum ${minimum}:1`,
  );
}

for (const [theme, tokens] of [["terang", light], ["gelap", dark]]) {
  test(`tangga status terbaca di tema ${theme}`, () => {
    for (const rung of ["normal", "monitor", "warning", "critical", "breach"]) {
      check(theme, tokens, `--st-${rung}-fg`, `--st-${rung}-bg`, AA_TEXT, `badge ${rung}`);
    }
  });

  test(`teks utama dan sekunder terbaca di tema ${theme}`, () => {
    // Ketiga permukaan diperiksa, bukan hanya yang paling terang: teks sekunder
    // paling sering justru duduk di atas permukaan tersunken (baris tabel
    // belang, panel, footer), dan di sanalah rasionya paling tipis.
    for (const surface of ["--surface", "--surface-raised", "--surface-sunken"]) {
      check(theme, tokens, "--text", surface, AA_TEXT, `teks di atas ${surface}`);
      check(theme, tokens, "--text-muted", surface, AA_TEXT, `teks sekunder di atas ${surface}`);
      check(theme, tokens, "--accent-ink", surface, AA_TEXT, `tautan di atas ${surface}`);
    }
  });

  test(`permukaan beraksen terbaca di tema ${theme}`, () => {
    // Aksen sebagai LATAR adalah warna yang berbeda dari aksen sebagai TEKS.
    check(theme, tokens, "--on-accent", "--accent-fill", AA_TEXT, "tombol primer");
  });

  test(`tombol berbahaya terbaca di tema ${theme}`, () => {
    check(theme, tokens, "--st-breach-fg", "--surface-raised", AA_TEXT, ".btn-danger");
  });

  test(`teks sel heatmap terbaca di tema ${theme}`, () => {
    // Setiap rung, bukan hanya Breach: isian sel adalah warna penuh dan tinta
    // yang salah di salah satunya membuat koordinat lokasi hilang.
    for (const rung of ["normal", "monitor", "warning", "critical"]) {
      check(theme, tokens, "--on-heat", `--heat-${rung}`, AA_TEXT, `sel ${rung}`);
    }
    check(theme, tokens, "--on-heat-breach", "--heat-breach", AA_TEXT, "sel Breach");
  });

  test(`penanda non-teks cukup kontras di tema ${theme}`, () => {
    check(theme, tokens, "--teal-ink", "--surface-raised", AA_NON_TEXT, "titik KPI teal");
    // Batas kontrol yang dapat dioperasikan — WCAG 1.4.11. Diperiksa pada
    // KETIGA permukaan: kotak isian muncul di kartu, panel, dan baris tabel.
    // Garis pemisah dekoratif (--border-strong) memang dikecualikan.
    for (const surface of ["--surface", "--surface-raised", "--surface-sunken"]) {
      check(theme, tokens, "--control-border", surface, AA_NON_TEXT, `tepi kotak isian di atas ${surface}`);
    }
  });
}

test("kedua tema mendefinisikan token yang sama persis", () => {
  // Token yang hanya ada di salah satu tema adalah cacat yang tidak terlihat
  // sampai seseorang membuka tema satunya: nilainya jatuh ke tema lain, atau
  // hilang sama sekali dan elemennya mewarisi warna yang tidak disengaja.
  const onlyLight = Object.keys(light).filter((key) => !(key in dark));
  const onlyDark = Object.keys(dark).filter((key) => !(key in light));
  assert.deepEqual(onlyLight, [], "token ini tidak punya nilai tema gelap");
  assert.deepEqual(onlyDark, [], "token ini tidak punya nilai tema terang");
});

test("warna keras tidak menyelinap kembali ke komponen antarmuka", () => {
  // Warna yang ditulis langsung tidak dapat mengikuti tema. Yang tersisa hanya
  // logo merek (identitasnya memang tetap) dan tirai gelap di belakang modal
  // (yang memang bekerja di atas kedua tema).
  const offenders = [];
  for (const file of ["../components/ui/kpi-card.tsx", "../components/domain/alert-board.tsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const match of source.matchAll(/#[0-9A-Fa-f]{6}\b/g)) offenders.push(`${file}: ${match[0]}`);
  }
  assert.deepEqual(offenders, [], "pakai token var(--…) supaya warnanya ikut tema");
});
