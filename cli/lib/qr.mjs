// A QR code printed in the terminal with Unicode half blocks. The encoder is Nayuki's (MIT), in ../vendor.
import qrcodegen from '../vendor/qrcodegen.mjs';

const QUIET = 3; // light border, in modules

export function qrMatrix(text) {
  const qr = qrcodegen.QrCode.encodeText(String(text), qrcodegen.QrCode.Ecc.MEDIUM);
  const size = qr.size + QUIET * 2;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [];
    for (let x = 0; x < size; x++) row.push(qr.getModule(x - QUIET, y - QUIET));
    rows.push(row);
  }
  return rows;
}

// Black on white whatever the terminal colours are: each text line covers two rows of modules.
export function renderQr(text) {
  const m = qrMatrix(text);
  const on = '\u001b[30;47m';
  const off = '\u001b[0m';
  const lines = [];
  for (let y = 0; y < m.length; y += 2) {
    let line = on;
    for (let x = 0; x < m.length; x++) {
      const top = m[y][x];
      const bottom = y + 1 < m.length ? m[y + 1][x] : false;
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line + off);
  }
  return lines.join('\n');
}
