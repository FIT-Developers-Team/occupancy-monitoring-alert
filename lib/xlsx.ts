// Penulis XLSX tanpa dependensi (OOXML SpreadsheetML + ZIP via node:zlib).
//
// Ekspor harus utuh dalam SATU berkas sesuai filter — tanpa pembagian batch —
// sehingga menulis CSV atau memecah unduhan per halaman bukan pilihan. Menambah
// pustaka pihak ketiga hanya untuk itu juga tidak sepadan: bagian OOXML yang
// dibutuhkan (satu worksheet, inline string, autofilter, freeze pane) kecil dan
// stabil, jadi berkas ini menuliskannya langsung.
import { deflateRawSync } from "node:zlib";

/** Nilai sel yang bermakna. Baris boleh membawa properti lain — kolom yang
 * tidak terdaftar tidak pernah dibaca, sehingga objek domain apa adanya dapat
 * dioper tanpa pemetaan ulang. */
export type XlsxValue = string | number | boolean | null | undefined;

export type XlsxRow = Record<string, unknown>;

export type XlsxColumnType = "text" | "integer" | "number" | "percent";

export interface XlsxColumn {
  /** Kunci pada objek baris. */
  key: string;
  /** Judul kolom pada baris pertama. */
  header: string;
  type?: XlsxColumnType;
  /** Lebar kolom (karakter). Dihitung otomatis bila kosong. */
  width?: number;
}

export interface XlsxSheet {
  name: string;
  columns: XlsxColumn[];
  rows: XlsxRow[];
}

/**
 * Batas keras Excel adalah 1.048.576 baris termasuk header. Ekspor dipotong
 * satu baris di bawahnya agar berkas tetap dapat dibuka, bukan rusak diam-diam.
 */
export const XLSX_MAX_ROWS = 1_048_575;

// ---- ZIP -------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** DOS timestamp dipakai apa adanya oleh Excel; detik dibulatkan ke kelipatan 2. */
function dosDateTime(date: Date): { time: number; date: number } {
  const time =
    (Math.floor(date.getSeconds() / 2) & 0x1f) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getHours() & 0x1f) << 11);
  const day =
    (date.getDate() & 0x1f) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    ((Math.max(0, date.getFullYear() - 1980) & 0x7f) << 9);
  return { time, date: day };
}

function zip(entries: ZipEntry[], now = new Date()): Buffer {
  const { time, date } = dosDateTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data, { level: 6 });
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versi minimum
    local.writeUInt16LE(0x0800, 6); // bendera: nama berkas UTF-8
    local.writeUInt16LE(8, 8); // metode deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // versi pembuat
    central.writeUInt16LE(20, 6); // versi minimum
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // komentar
    central.writeUInt16LE(0, 34); // nomor disk
    central.writeUInt16LE(0, 36); // atribut internal
    central.writeUInt32LE(0, 38); // atribut eksternal
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralDirectory, end]);
}

// ---- XML -------------------------------------------------------------------

// Excel menolak berkas yang memuat karakter kontrol XML 1.0; tab, LF dan CR
// tetap dipertahankan karena sah di dalam <t>.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(CONTROL_CHARS, "");
}

/** A, B, … Z, AA, AB … — referensi kolom OOXML. */
function columnLetter(index: number): string {
  let letters = "";
  let n = index + 1;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - remainder) / 26);
  }
  return letters;
}

/**
 * Nama sheet Excel: maksimal 31 karakter dan tidak boleh memuat : \ / ? * [ ].
 * Nama tak valid membuat berkas ditolak saat dibuka, bukan sekadar tampil aneh.
 */
function safeSheetName(name: string, fallback: string): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31);
  return cleaned || fallback;
}

const STYLE_TEXT = 0;
const STYLE_HEADER = 1;
const STYLE_INTEGER = 2;
const STYLE_NUMBER = 3;
const STYLE_PERCENT = 4;

function styleFor(type: XlsxColumnType | undefined): number {
  if (type === "integer") return STYLE_INTEGER;
  if (type === "number") return STYLE_NUMBER;
  if (type === "percent") return STYLE_PERCENT;
  return STYLE_TEXT;
}

function isNumericType(type: XlsxColumnType | undefined): boolean {
  return type === "integer" || type === "number" || type === "percent";
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

function numericValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function autoWidth(column: XlsxColumn, rows: XlsxRow[]): number {
  if (column.width) return Math.min(64, Math.max(8, column.width));
  let widest = column.header.length;
  // Lebar diukur dari sampel: memindai 200k baris hanya untuk lebar kolom
  // membuat ekspor besar terasa menggantung tanpa manfaat yang terlihat.
  const sample = Math.min(rows.length, 400);
  for (let index = 0; index < sample; index += 1) {
    const length = cellText(rows[index][column.key]).length;
    if (length > widest) widest = length;
  }
  return Math.min(52, Math.max(9, widest + 2));
}

function sheetXml(sheet: XlsxSheet): string {
  const { columns, rows } = sheet;
  const lastColumn = columnLetter(Math.max(0, columns.length - 1));
  const lastRow = rows.length + 1;
  const parts: string[] = [];

  parts.push(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    `<dimension ref="A1:${lastColumn}${lastRow}"/>`,
    '<sheetViews><sheetView workbookViewId="0">',
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
    '</sheetView></sheetViews>',
    '<sheetFormatPr defaultRowHeight="15"/>',
    "<cols>",
  );
  columns.forEach((column, index) => {
    parts.push(
      `<col min="${index + 1}" max="${index + 1}" width="${autoWidth(column, rows)}" customWidth="1"/>`,
    );
  });
  parts.push("</cols>", "<sheetData>");

  parts.push('<row r="1" ht="22" customHeight="1">');
  columns.forEach((column, index) => {
    parts.push(
      `<c r="${columnLetter(index)}1" s="${STYLE_HEADER}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(column.header)}</t></is></c>`,
    );
  });
  parts.push("</row>");

  rows.forEach((row, rowIndex) => {
    const reference = rowIndex + 2;
    parts.push(`<row r="${reference}">`);
    columns.forEach((column, columnIndex) => {
      const raw = row[column.key];
      const address = `${columnLetter(columnIndex)}${reference}`;
      if (isNumericType(column.type)) {
        const numeric = numericValue(raw);
        // Sel kosong tetap ditulis kosong, bukan 0: 0% dan "belum ada
        // kapasitas" adalah dua kesimpulan berbeda bagi yang membaca.
        if (numeric === null) return;
        parts.push(`<c r="${address}" s="${styleFor(column.type)}"><v>${numeric}</v></c>`);
        return;
      }
      const text = cellText(raw);
      if (!text) return;
      parts.push(
        `<c r="${address}" s="${STYLE_TEXT}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`,
      );
    });
    parts.push("</row>");
  });

  parts.push("</sheetData>");
  if (columns.length) parts.push(`<autoFilter ref="A1:${lastColumn}${lastRow}"/>`);
  parts.push("</worksheet>");
  return parts.join("");
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3">
<numFmt numFmtId="164" formatCode="#,##0"/>
<numFmt numFmtId="165" formatCode="#,##0.000"/>
<numFmt numFmtId="166" formatCode="0.0&quot;%&quot;"/>
</numFmts>
<fonts count="2">
<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF16324F"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/** Susun buku kerja XLSX lengkap sebagai satu Buffer siap unduh. */
export function buildXlsx(sheets: XlsxSheet[]): Buffer {
  const used = new Set<string>();
  const prepared = sheets.map((sheet, index) => {
    let name = safeSheetName(sheet.name, `Sheet${index + 1}`);
    let suffix = 2;
    while (used.has(name.toLowerCase())) {
      const trimmed = name.slice(0, 31 - String(suffix).length - 1);
      name = `${trimmed} ${suffix}`;
      suffix += 1;
    }
    used.add(name.toLowerCase());
    return {
      ...sheet,
      name,
      rows: sheet.rows.length > XLSX_MAX_ROWS ? sheet.rows.slice(0, XLSX_MAX_ROWS) : sheet.rows,
    };
  });

  const contentTypes = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    ...prepared.map((_, index) =>
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`),
    "</Types>",
  ].join("");

  const workbook = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    "<sheets>",
    ...prepared.map((sheet, index) =>
      `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`),
    "</sheets></workbook>",
  ].join("");

  const workbookRels = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ...prepared.map((_, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`),
    `<Relationship Id="rId${prepared.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    "</Relationships>",
  ].join("");

  const rootRels = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
    "</Relationships>",
  ].join("");

  const utf8 = (value: string) => Buffer.from(value, "utf8");
  return zip([
    { name: "[Content_Types].xml", data: utf8(contentTypes) },
    { name: "_rels/.rels", data: utf8(rootRels) },
    { name: "xl/workbook.xml", data: utf8(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: utf8(workbookRels) },
    { name: "xl/styles.xml", data: utf8(STYLES_XML) },
    ...prepared.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: utf8(sheetXml(sheet)),
    })),
  ]);
}

/** Sheet "Filter" berisi ringkasan cakupan agar berkas dapat diaudit ulang. */
export function filterSheet(
  name: string,
  entries: Array<{ label: string; value: string }>,
): XlsxSheet {
  return {
    name,
    columns: [
      { key: "label", header: "Kriteria", width: 30 },
      { key: "value", header: "Nilai", width: 60 },
    ],
    rows: entries.map((entry) => ({ label: entry.label, value: entry.value })),
  };
}

/** Nama berkas aman untuk header Content-Disposition dan filesystem Windows. */
export function safeFilename(base: string): string {
  const cleaned = base
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (cleaned || "export").slice(0, 120);
}
