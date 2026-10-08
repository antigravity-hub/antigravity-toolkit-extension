/**
 * Lightweight, zero-dependency QR Code generator that outputs an SVG string.
 * Supports Byte encoding (UTF-8 / ISO-8859-1) up to Version 6 (up to 134 bytes at ECC-M, or 172 bytes at ECC-L).
 */

// Galois Field 256 math tables for Reed-Solomon ECC
const GF256_EXP = new Uint8Array(512);
const GF256_LOG = new Uint8Array(256);

(function initGF256() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF256_EXP[i] = x;
    GF256_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d; // Primitive polynomial x^8 + x^4 + x^3 + x^2 + 1
    }
  }
  for (let i = 255; i < 512; i++) {
    GF256_EXP[i] = GF256_EXP[i - 255];
  }
})();

function gfMul(x: number, y: number): number {
  if (x === 0 || y === 0) return 0;
  return GF256_EXP[GF256_LOG[x] + GF256_LOG[y]];
}

function polyMul(p: number[], q: number[]): number[] {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let i = 0; i < p.length; i++) {
    for (let j = 0; j < q.length; j++) {
      r[i + j] ^= gfMul(p[i], q[j]);
    }
  }
  return r;
}

function getGeneratorPoly(degree: number): number[] {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    g = polyMul(g, [1, GF256_EXP[i]]);
  }
  return g;
}

function calcEcc(data: number[], eccCount: number): number[] {
  const gen = getGeneratorPoly(eccCount);
  const msg = data.concat(new Array(eccCount).fill(0));
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        msg[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return msg.slice(data.length);
}

// QR Table: [version, totalDataBytes, eccBytesPerBlock, numBlocks]
// Using ECC level M (approx 15% recovery)
interface VersionInfo {
  version: number;
  size: number;
  totalDataBytes: number;
  eccPerBlock: number;
  blocks: number;
  alignPos: number[];
}

const QR_VERSIONS: VersionInfo[] = [
  { version: 1, size: 21, totalDataBytes: 16, eccPerBlock: 10, blocks: 1, alignPos: [] },
  { version: 2, size: 25, totalDataBytes: 28, eccPerBlock: 16, blocks: 1, alignPos: [6, 18] },
  { version: 3, size: 29, totalDataBytes: 44, eccPerBlock: 26, blocks: 1, alignPos: [6, 22] },
  { version: 4, size: 33, totalDataBytes: 64, eccPerBlock: 18, blocks: 2, alignPos: [6, 26] },
  { version: 5, size: 37, totalDataBytes: 86, eccPerBlock: 24, blocks: 2, alignPos: [6, 30] },
  { version: 6, size: 41, totalDataBytes: 108, eccPerBlock: 16, blocks: 4, alignPos: [6, 34] },
  { version: 7, size: 45, totalDataBytes: 124, eccPerBlock: 18, blocks: 4, alignPos: [6, 22, 38] },
  { version: 8, size: 49, totalDataBytes: 154, eccPerBlock: 22, blocks: 4, alignPos: [6, 24, 42] },
];

export function generateQrSvg(text: string, sizePx = 180): string {
  const utf8 = Buffer.from(text, 'utf8');
  const len = utf8.length;

  let verInfo: VersionInfo | undefined;
  for (const v of QR_VERSIONS) {
    // Overhead: 4 bits mode + 8 bits length indicator = 1.5 bytes + 0.5 terminator = ~2-3 bytes
    if (v.totalDataBytes >= len + 3) {
      verInfo = v;
      break;
    }
  }

  if (!verInfo) {
    // Fallback to highest version supported
    verInfo = QR_VERSIONS[QR_VERSIONS.length - 1];
  }

  const N = verInfo.size;
  const matrix: (number | null)[][] = Array.from({ length: N }, () => Array(N).fill(null));
  const isFunction: boolean[][] = Array.from({ length: N }, () => Array(N).fill(false));

  function setFunc(r: number, c: number, v: number) {
    if (r >= 0 && r < N && c >= 0 && c < N) {
      matrix[r][c] = v;
      isFunction[r][c] = true;
    }
  }

  // 1. Finder patterns (7x7) + Separator
  function drawFinder(r: number, c: number) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= N || nc < 0 || nc >= N) continue;
        if (dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6) {
          if (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4)) {
            setFunc(nr, nc, 1);
          } else {
            setFunc(nr, nc, 0);
          }
        } else {
          setFunc(nr, nc, 0); // Separator
        }
      }
    }
  }

  drawFinder(0, 0);
  drawFinder(0, N - 7);
  drawFinder(N - 7, 0);

  // 2. Alignment patterns (5x5)
  const coords = verInfo.alignPos;
  for (let i = 0; i < coords.length; i++) {
    for (let j = 0; j < coords.length; j++) {
      const r = coords[i];
      const c = coords[j];
      if (isFunction[r][c]) continue; // Skip finders
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const isBlack = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFunc(r + dr, c + dc, isBlack ? 1 : 0);
        }
      }
    }
  }

  // 3. Timing patterns
  for (let i = 8; i < N - 8; i++) {
    if (!isFunction[6][i]) setFunc(6, i, i % 2 === 0 ? 1 : 0);
    if (!isFunction[i][6]) setFunc(i, 6, i % 2 === 0 ? 1 : 0);
  }

  // Dark module
  setFunc(4 * verInfo.version + 9, 8, 1);

  // 4. Reserve format info
  for (let i = 0; i <= 8; i++) {
    if (!isFunction[8][i]) setFunc(8, i, 0);
    if (!isFunction[i][8]) setFunc(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    if (!isFunction[8][N - 1 - i]) setFunc(8, N - 1 - i, 0);
    if (!isFunction[N - 1 - i][8]) setFunc(N - 1 - i, 8, 0);
  }

  // 4b. Reserve version info for version >= 7
  if (verInfo.version >= 7) {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 6; c++) {
        setFunc(N - 11 + r, c, 0);
      }
    }
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 3; c++) {
        setFunc(r, N - 11 + c, 0);
      }
    }
  }

  // 5. Build Bitstream (Byte mode = 0100)
  const bits: number[] = [];
  function pushBits(val: number, count: number) {
    for (let i = count - 1; i >= 0; i--) {
      bits.push((val >>> i) & 1);
    }
  }

  pushBits(0b0100, 4); // Byte mode
  pushBits(len, 8); // Character count (8 bits for V1-9 byte mode)
  for (let i = 0; i < len; i++) {
    pushBits(utf8[i], 8);
  }

  // Terminator (up to 4 bits)
  const totalDataBits = verInfo.totalDataBytes * 8;
  const termLen = Math.min(4, totalDataBits - bits.length);
  for (let i = 0; i < termLen; i++) bits.push(0);

  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);

  // Pad bytes: 0xEC (11101100), 0x11 (00010001)
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (bits.length < totalDataBits) {
    pushBits(padBytes[padIdx % 2], 8);
    padIdx++;
  }

  // Convert to bytes
  const dataBytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) {
      b = (b << 1) | bits[i + j];
    }
    dataBytes.push(b);
  }

  // Partition into blocks and calculate ECC
  const blocks = verInfo.blocks;
  const dataBytesPerBlock = Math.floor(verInfo.totalDataBytes / blocks);
  const eccPerBlock = verInfo.eccPerBlock;

  const blockData: number[][] = [];
  const blockEcc: number[][] = [];
  let offset = 0;

  for (let b = 0; b < blocks; b++) {
    const raw = dataBytes.slice(offset, offset + dataBytesPerBlock);
    offset += dataBytesPerBlock;
    blockData.push(raw);
    blockEcc.push(calcEcc(raw, eccPerBlock));
  }

  // Interleave data and ECC codewords
  const finalCodewords: number[] = [];
  for (let i = 0; i < dataBytesPerBlock; i++) {
    for (let b = 0; b < blocks; b++) {
      finalCodewords.push(blockData[b][i]);
    }
  }
  for (let i = 0; i < eccPerBlock; i++) {
    for (let b = 0; b < blocks; b++) {
      finalCodewords.push(blockEcc[b][i]);
    }
  }

  // 6. Place data in matrix (zigzag)
  const finalBits: number[] = [];
  for (const b of finalCodewords) {
    for (let i = 7; i >= 0; i--) {
      finalBits.push((b >>> i) & 1);
    }
  }

  let bitIdx = 0;
  let dir = -1; // -1 = up, 1 = down
  let r = N - 1;
  let c = N - 1;

  while (c > 0) {
    if (c === 6) c--; // Skip vertical timing column
    for (let step = 0; step < N; step++) {
      const row = r;
      for (let colOffset = 0; colOffset < 2; colOffset++) {
        const col = c - colOffset;
        if (!isFunction[row][col]) {
          const bit = bitIdx < finalBits.length ? finalBits[bitIdx++] : 0;
          matrix[row][col] = bit;
        }
      }
      r += dir;
    }
    dir = -dir;
    r += dir;
    c -= 2;
  }

  // 7. Apply Mask Pattern 0: (row + col) % 2 == 0
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      if (!isFunction[row][col] && matrix[row][col] !== null) {
        if ((row + col) % 2 === 0) {
          matrix[row][col] = matrix[row][col]! ^ 1;
        }
      }
    }
  }

  // 8. Format Information for ECC Level M (00), Mask 0 (000) -> 101010000010010
  // Standard BCH(15,5) code for (M, Mask 0) XORed with 101010000010010 = 0x5412 ^ 0x0000
  const formatBits = [1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0];
  const fmtCoords = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
  ];
  for (let i = 0; i < 15; i++) {
    matrix[fmtCoords[i][0]][fmtCoords[i][1]] = formatBits[i];
  }

  const fmtCoords2 = [
    [N - 1, 8], [N - 2, 8], [N - 3, 8], [N - 4, 8], [N - 5, 8], [N - 6, 8], [N - 7, 8],
    [8, N - 8], [8, N - 7], [8, N - 6], [8, N - 5], [8, N - 4], [8, N - 3], [8, N - 2], [8, N - 1]
  ];
  for (let i = 0; i < 15; i++) {
    matrix[fmtCoords2[i][0]][fmtCoords2[i][1]] = formatBits[i];
  }

  // 8b. Version Information for Version >= 7 (BCH(18,6))
  if (verInfo.version >= 7) {
    let rem = verInfo.version << 12;
    const poly = 0x1F25;
    for (let i = 17; i >= 12; i--) {
      if ((rem >>> i) & 1) {
        rem ^= (poly << (i - 12));
      }
    }
    const fullVersionBits = (verInfo.version << 12) | rem;

    // Bottom-left: 3 rows (N-11 to N-9) x 6 columns (0 to 5)
    for (let c = 0; c < 6; c++) {
      for (let r = 0; r < 3; r++) {
        const bit = (fullVersionBits >>> (c * 3 + r)) & 1;
        matrix[N - 11 + r][c] = bit;
      }
    }

    // Top-right: 6 rows (0 to 5) x 3 columns (N-11 to N-9)
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 3; c++) {
        const bit = (fullVersionBits >>> (r * 3 + c)) & 1;
        matrix[r][N - 11 + c] = bit;
      }
    }
  }

  // 9. Generate SVG with standard 4-module quiet zone
  const quietZone = 4;
  const totalModules = N + quietZone * 2;
  const cellSize = 5;
  const viewBoxSize = totalModules * cellSize;

  let pathD = '';
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      if (matrix[row][col] === 1) {
        const x = (col + quietZone) * cellSize;
        const y = (row + quietZone) * cellSize;
        pathD += `M${x},${y}h${cellSize}v${cellSize}h-${cellSize}z `;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBoxSize} ${viewBoxSize}" width="${sizePx}" height="${sizePx}" style="display:block; shape-rendering:crispEdges; border-radius:8px; background:#ffffff;">` +
    `<rect width="${viewBoxSize}" height="${viewBoxSize}" fill="#ffffff"/>` +
    `<path d="${pathD}" fill="#0f172a"/>` +
    `</svg>`;
}
