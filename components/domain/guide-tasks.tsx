"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n-client";

interface Step {
  text: string;
  /** Optional in-app destination for the step. */
  href?: string;
  linkLabel?: string;
}

interface Task {
  id: string;
  audience: "all" | "spv" | "admin";
  title: string;
  goal: string;
  steps: Step[];
  /** What proves the step worked — the part people usually have to guess. */
  done: string;
}

/**
 * Task-oriented guide.
 *
 * The previous page was a wall of reference cards that named config files and
 * internal fields. People arriving here want to finish one job, so each entry
 * is a short procedure with a way to tell it worked.
 */
export default function GuideTasks() {
  const { lang } = useT();
  const c = useCallback((id: string, en: string) => (lang === "en" ? en : id), [lang]);
  const [openId, setOpenId] = useState<string | null>("alert-chat");
  const [audience, setAudience] = useState<"all" | "spv" | "admin">("all");

  const tasks: Task[] = useMemo(() => [
    {
      id: "alert-chat",
      audience: "admin",
      title: c("Mengirim alert ke Google Chat", "Send alerts to Google Chat"),
      goal: c(
        "Supaya tim gudang menerima pemberitahuan di ruang chat yang sudah dipakai sehari-hari.",
        "So the warehouse team is notified in the chat room they already use every day.",
      ),
      steps: [
        { text: c(
          "Di Google Chat, buka Space tim lalu buat webhook: nama Space → Apps & integrations → Webhooks → Add webhook. Salin URL-nya.",
          "In Google Chat, open the team Space then create a webhook: Space name → Apps & integrations → Webhooks → Add webhook. Copy the URL.",
        ) },
        { text: c(
          "Kirim satu pesan pembuka di Space untuk tiap gudang, misalnya \"Alert PGS\". Pada pesan itu klik ⋮ → Salin link.",
          "Post one opening message in the Space for each warehouse, for example \"PGS alerts\". On that message click ⋮ → Copy link.",
        ) },
        {
          text: c(
            "Buka Pengaturan → Eskalasi, tambahkan rute: tempel URL webhook, centang gudangnya, isi email PIC, pilih \"Thread yang sudah ada\", lalu tempel link tadi.",
            "Open Settings → Escalation, add a route: paste the webhook URL, tick the warehouses, fill in the PIC emails, choose \"An existing thread\", then paste that link.",
          ),
          href: "/settings",
          linkLabel: c("Buka Pengaturan", "Open Settings"),
        },
        { text: c(
          "Tekan Simpan. Ini wajib — Uji kirim memakai isian di layar, tetapi alert memakai konfigurasi tersimpan.",
          "Press Save. This matters — Test send uses what is on screen, but alerts use the stored configuration.",
        ) },
        { text: c("Tekan Uji kirim pada rute tersebut.", "Press Test send on that route.") },
      ],
      done: c(
        "Pesan uji muncul di dalam thread yang Anda pilih, dan chip gudang pada panel cakupan berubah biru setelah halaman dimuat ulang.",
        "The test message appears inside the thread you chose, and the warehouse chip in the coverage panel turns blue after you reload the page.",
      ),
    },
    {
      id: "handle-alert",
      audience: "spv",
      title: c("Menangani alert yang masuk", "Handling an incoming alert"),
      goal: c(
        "Menghentikan eskalasi berjalan dan mencatat siapa yang menindaklanjuti.",
        "Stop the escalation clock and record who is following up.",
      ),
      steps: [
        {
          text: c("Buka Alert Centre dan pilih alert paling atas.", "Open the Alert Centre and pick the topmost alert."),
          href: "/alerts",
          linkLabel: c("Buka Alert Centre", "Open Alert Centre"),
        },
        { text: c(
          "Tekan Tangani (Acknowledge) begitu Anda mulai menanganinya. Ini menghentikan kenaikan level ke atasan.",
          "Press Acknowledge as soon as you start working on it. This stops the alert climbing to the next tier.",
        ) },
        { text: c(
          "Setelah stok dipindahkan atau kapasitas diperbaiki, tekan Selesai dan tulis singkat apa yang dilakukan.",
          "Once stock is moved or capacity is corrected, press Resolve and note briefly what was done.",
        ) },
      ],
      done: c(
        "Status alert berubah dan tidak lagi terhitung pada angka \"Open\" di bagian atas halaman.",
        "The alert status changes and it no longer counts towards the \"Open\" figure at the top of the page.",
      ),
    },
    {
      id: "read-heatmap",
      audience: "all",
      title: c("Membaca heatmap sampai level bin", "Reading the heatmap down to bin level"),
      goal: c(
        "Menemukan lokasi mana yang penuh, bukan sekadar tahu gudangnya penuh.",
        "Find which locations are full, not merely that the warehouse is full.",
      ),
      steps: [
        {
          text: c("Buka Heatmap dan pilih gudang.", "Open the Heatmap and choose a warehouse."),
          href: "/heatmap",
          linkLabel: c("Buka Heatmap", "Open Heatmap"),
        },
        { text: c(
          "Klik sebuah zona untuk membukanya. Tampilan dalam tersusun Aisle → Bay → Level → Bin, sama seperti raknya di lapangan.",
          "Click a zone to open it. The inside view is laid out Aisle → Bay → Level → Bin, the same as the rack on the floor.",
        ) },
        { text: c(
          "Sel bergaris putus-putus berarti lokasi aktif tetapi kosong — itu kapasitas yang masih bisa dipakai.",
          "A dashed cell means the location is active but empty — that is capacity you can still use.",
        ) },
        { text: c("Klik satu sel untuk melihat SKU yang menempatinya.", "Click a cell to see the SKUs occupying it.") },
      ],
      done: c(
        "Anda bisa menyebut kode lokasi yang penuh, contohnya PGS-PLA1-01-02-L1-03.",
        "You can name the location code that is full, for example PGS-PLA1-01-02-L1-03.",
      ),
    },
    {
      id: "capacity",
      audience: "admin",
      title: c("Memperbaiki okupansi di atas 100%", "Fixing occupancy above 100%"),
      goal: c(
        "Angka seperti 2682% berarti kapasitas lokasi belum diisi, bukan gudangnya meledak.",
        "A figure like 2682% means the location capacity has not been set, not that the warehouse exploded.",
      ),
      steps: [
        {
          text: c("Buka Pengaturan → Kapasitas.", "Open Settings → Capacity."),
          href: "/settings",
          linkLabel: c("Buka Pengaturan", "Open Settings"),
        },
        { text: c(
          "Tambahkan rule dengan tombol di bawah tabel, isi cakupannya (gudang, zona, atau rak), lalu isi kapasitas maksimum.",
          "Add a rule with the button below the table, set its scope (warehouse, zone, or rack), then fill in the maximum capacity.",
        ) },
        { text: c(
          "Aturan yang lebih spesifik menang atas yang umum, jadi Anda bisa menetapkan satu nilai untuk seluruh gudang lalu mengecualikan rak tertentu.",
          "A more specific rule wins over a general one, so you can set one value for a whole warehouse then carve out particular racks.",
        ) },
      ],
      done: c(
        "Persentase zona kembali masuk akal, di bawah atau sekitar 100%.",
        "Zone percentages return to sensible values, at or below roughly 100%.",
      ),
    },
    {
      id: "escalation",
      audience: "admin",
      title: c("Mengubah urutan eskalasi", "Changing the escalation order"),
      goal: c(
        "Menentukan siapa yang dihubungi lebih dulu dan berapa lama sebelum naik ke atasan.",
        "Decide who is contacted first and how long before it climbs to the next person.",
      ),
      steps: [
        {
          text: c("Buka Pengaturan → Eskalasi.", "Open Settings → Escalation."),
          href: "/settings",
          linkLabel: c("Buka Pengaturan", "Open Settings"),
        },
        { text: c(
          "Ubah nama tiap tingkat sesuai jabatan di tim Anda, dan atur jeda menitnya. Tingkat pertama selalu tanpa jeda.",
          "Rename each tier to match the roles in your team and set the delay in minutes. The first tier always has no delay.",
        ) },
        { text: c(
          "Gunakan Up dan Down untuk menukar urutan tingkat; penomorannya menyesuaikan sendiri.",
          "Use Up and Down to reorder the tiers; the numbering adjusts itself.",
        ) },
        { text: c(
          "Alert dikirim ke tingkat pertama sampai tingkat awalnya sekaligus, jadi supervisor selalu ikut menerima.",
          "An alert notifies every tier from the first up to its starting tier, so the supervisor always receives it too.",
        ) },
      ],
      done: c(
        "Alert baru menampilkan nama tingkat yang Anda tetapkan pada kartu Google Chat.",
        "New alerts show the tier name you set on the Google Chat card.",
      ),
    },
  ], [c]);

  const visible = tasks.filter((task) => audience === "all" || task.audience === audience || task.audience === "all");

  return (
    <div className="guide-tasks">
      <div className="guide-filter" role="group" aria-label={c("Saring panduan", "Filter guide")}>
        {([
          ["all", c("Semua", "Everything")],
          ["spv", c("Operasional harian", "Daily operations")],
          ["admin", c("Pengaturan", "Configuration")],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`chip ${audience === value ? "chip-accent" : ""}`}
            aria-pressed={audience === value}
            onClick={() => setAudience(value)}
          >
            {label}
          </button>
        ))}
      </div>

      <ol className="guide-task-list">
        {visible.map((task, index) => {
          const open = openId === task.id;
          return (
            <li key={task.id} className={`guide-task ${open ? "is-open" : ""}`}>
              <button
                type="button"
                className="guide-task-head"
                aria-expanded={open}
                onClick={() => setOpenId(open ? null : task.id)}
              >
                <span className="guide-task-index num">{index + 1}</span>
                <span className="guide-task-title">
                  <strong>{task.title}</strong>
                  <small>{task.goal}</small>
                </span>
                <span className="guide-task-chevron" aria-hidden>{open ? "−" : "+"}</span>
              </button>
              {open && (
                <div className="guide-task-body">
                  <ol className="guide-steps">
                    {task.steps.map((step, stepIndex) => (
                      <li key={stepIndex}>
                        <span>{step.text}</span>
                        {step.href && (
                          <Link className="btn btn-sm guide-step-link" href={step.href}>
                            {step.linkLabel}
                          </Link>
                        )}
                      </li>
                    ))}
                  </ol>
                  <p className="guide-done">
                    <b>{c("Tandanya berhasil", "You know it worked when")}</b> {task.done}
                  </p>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
