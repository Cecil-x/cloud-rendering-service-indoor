import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const modelRoot = path.join(projectRoot, 'models');

const sourceArg = process.argv[2];
const tilePoints = Number(process.env.TILE_POINTS || process.argv[3] || 200_000);

if (!sourceArg) {
  console.error('Usage: node scripts/convert-ply-to-tiles.js <file.ply> [tilePoints]');
  process.exit(1);
}

if (!Number.isFinite(tilePoints) || tilePoints <= 0) {
  console.error('tilePoints must be a positive number');
  process.exit(1);
}

const sourcePath = resolveSourcePath(sourceArg);
if (!sourcePath || !fs.existsSync(sourcePath)) {
  console.error(`Source file not found or outside project: ${sourceArg}`);
  process.exit(1);
}

const sourceName = path.basename(sourcePath, path.extname(sourcePath));
const outputDir = path.join(path.dirname(sourcePath), `${sourceName}.tiles`);
fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

const source = fs.readFileSync(sourcePath);
const { header, bodyOffset, format, vertexCount, properties } = parsePlyHeader(source);

if (!['binary_little_endian', 'ascii'].includes(format)) {
  throw new Error(`Unsupported PLY format: ${format}`);
}

const layout = createLayout(properties);
const xProp = layout.find(prop => prop.name === 'x');
const yProp = layout.find(prop => prop.name === 'y');
const zProp = layout.find(prop => prop.name === 'z');
const rProp = layout.find(prop => prop.name === 'red');
const gProp = layout.find(prop => prop.name === 'green');
const bProp = layout.find(prop => prop.name === 'blue');

if (!xProp || !yProp || !zProp) {
  throw new Error('PLY vertex properties must include x, y, z');
}

const hasColor = Boolean(rProp && gProp && bProp);
const tileCount = Math.ceil(vertexCount / tilePoints);
const tiles = [];
const bounds = createEmptyBounds();

console.log(`Source: ${path.relative(projectRoot, sourcePath)}`);
console.log(`Format: ${format}`);
console.log(`Vertices: ${vertexCount}`);
console.log(`Tile points: ${tilePoints}`);
console.log(`Tiles: ${tileCount}`);
console.log(`Color: ${hasColor ? 'rgb' : 'none'}`);

if (format === 'binary_little_endian') {
  convertBinary();
} else {
  convertAscii();
}

const manifest = {
  format: 'points-tiles-v1',
  source: path.basename(sourcePath),
  pointCount: vertexCount,
  tilePointTarget: tilePoints,
  attributes: {
    position: 'float32x3',
    color: hasColor ? 'uint8x3-normalized' : null
  },
  bounds,
  tiles
};

fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Wrote: ${path.relative(projectRoot, outputDir)}/manifest.json`);

function resolveSourcePath(fileName) {
  const normalized = String(fileName || '').replace(/\\/g, '/');
  const candidates = [
    path.resolve(modelRoot, normalized),
    path.resolve(projectRoot, normalized)
  ];

  for (const candidate of candidates) {
    if (isInside(projectRoot, candidate) && fs.existsSync(candidate)) return candidate;
  }

  return null;
}

function isInside(root, filePath) {
  const relative = path.relative(root, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function convertBinary() {
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const recordSize = layout.reduce((sum, prop) => sum + prop.size, 0);

  for (let tileIndex = 0; tileIndex < tileCount; tileIndex++) {
    const start = tileIndex * tilePoints;
    const count = Math.min(tilePoints, vertexCount - start);
    const { positions, colors, tileBounds } = createTileBuffers(count);

    for (let i = 0; i < count; i++) {
      const sourceIndex = start + i;
      const base = bodyOffset + sourceIndex * recordSize;
      writePoint(i, view, base, positions, colors, tileBounds);
    }

    writeTile(tileIndex, count, positions, colors, tileBounds);
  }
}

function convertAscii() {
  const text = source.subarray(bodyOffset).toString('utf8');
  const lines = text.split(/\r?\n/);
  const xIndex = properties.findIndex(prop => prop.name === 'x');
  const yIndex = properties.findIndex(prop => prop.name === 'y');
  const zIndex = properties.findIndex(prop => prop.name === 'z');
  const rIndex = properties.findIndex(prop => prop.name === 'red');
  const gIndex = properties.findIndex(prop => prop.name === 'green');
  const bIndex = properties.findIndex(prop => prop.name === 'blue');

  for (let tileIndex = 0; tileIndex < tileCount; tileIndex++) {
    const start = tileIndex * tilePoints;
    const count = Math.min(tilePoints, vertexCount - start);
    const { positions, colors, tileBounds } = createTileBuffers(count);

    for (let i = 0; i < count; i++) {
      const values = lines[start + i].trim().split(/\s+/);
      const x = Number(values[xIndex]);
      const y = Number(values[yIndex]);
      const z = Number(values[zIndex]);
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      updateBounds(tileBounds, x, y, z);
      updateBounds(bounds, x, y, z);

      if (colors) {
        colors[i * 3] = Number(values[rIndex]);
        colors[i * 3 + 1] = Number(values[gIndex]);
        colors[i * 3 + 2] = Number(values[bIndex]);
      }
    }

    writeTile(tileIndex, count, positions, colors, tileBounds);
  }
}

function createTileBuffers(count) {
  return {
    positions: new Float32Array(count * 3),
    colors: hasColor ? new Uint8Array(count * 3) : null,
    tileBounds: createEmptyBounds()
  };
}

function writePoint(index, view, base, positions, colors, tileBounds) {
  const x = readPlyValue(view, base + xProp.offset, xProp.type);
  const y = readPlyValue(view, base + yProp.offset, yProp.type);
  const z = readPlyValue(view, base + zProp.offset, zProp.type);
  positions[index * 3] = x;
  positions[index * 3 + 1] = y;
  positions[index * 3 + 2] = z;
  updateBounds(tileBounds, x, y, z);
  updateBounds(bounds, x, y, z);

  if (colors) {
    colors[index * 3] = readPlyValue(view, base + rProp.offset, rProp.type);
    colors[index * 3 + 1] = readPlyValue(view, base + gProp.offset, gProp.type);
    colors[index * 3 + 2] = readPlyValue(view, base + bProp.offset, bProp.type);
  }
}

function writeTile(tileIndex, count, positions, colors, tileBounds) {
  const tileName = `tile_${String(tileIndex).padStart(5, '0')}.bin`;
  const tilePath = path.join(outputDir, tileName);
  const positionBytes = Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength);
  const buffers = [positionBytes];

  if (colors) {
    buffers.push(Buffer.from(colors.buffer, colors.byteOffset, colors.byteLength));
  }

  fs.writeFileSync(tilePath, Buffer.concat(buffers));
  tiles.push({ url: tileName, points: count, bounds: tileBounds });
  if ((tileIndex + 1) % 10 === 0 || tileIndex + 1 === tileCount) {
    console.log(`Wrote tile ${tileIndex + 1}/${tileCount}`);
  }
}

function parsePlyHeader(buffer) {
  const marker = Buffer.from('end_header');
  const markerIndex = buffer.indexOf(marker);
  if (markerIndex < 0) throw new Error('Invalid PLY: end_header not found');

  let bodyOffset = markerIndex + marker.length;
  while (bodyOffset < buffer.length && (buffer[bodyOffset] === 10 || buffer[bodyOffset] === 13)) bodyOffset++;

  const header = buffer.subarray(0, bodyOffset).toString('ascii');
  const lines = header.split(/\r?\n/);
  let format = '';
  let vertexCount = 0;
  let inVertex = false;
  const properties = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (!parts[0]) continue;

    if (parts[0] === 'format') {
      format = parts[1];
    } else if (parts[0] === 'element' && parts[1] === 'vertex') {
      vertexCount = Number(parts[2]);
      inVertex = true;
    } else if (parts[0] === 'element') {
      inVertex = false;
    } else if (inVertex && parts[0] === 'property') {
      if (parts[1] === 'list') throw new Error('List properties on vertices are not supported');
      properties.push({ type: parts[1], name: parts[2] });
    }
  }

  if (!format || !vertexCount || !properties.length) {
    throw new Error('Invalid PLY header');
  }

  return { header, bodyOffset, format, vertexCount, properties };
}

function createLayout(properties) {
  let offset = 0;
  return properties.map(prop => {
    const size = getPlyTypeSize(prop.type);
    const item = { ...prop, offset, size };
    offset += size;
    return item;
  });
}

function createEmptyBounds() {
  return {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity]
  };
}

function updateBounds(target, x, y, z) {
  target.min[0] = Math.min(target.min[0], x);
  target.min[1] = Math.min(target.min[1], y);
  target.min[2] = Math.min(target.min[2], z);
  target.max[0] = Math.max(target.max[0], x);
  target.max[1] = Math.max(target.max[1], y);
  target.max[2] = Math.max(target.max[2], z);
}

function getPlyTypeSize(type) {
  const sizes = {
    char: 1, uchar: 1, int8: 1, uint8: 1,
    short: 2, ushort: 2, int16: 2, uint16: 2,
    int: 4, uint: 4, int32: 4, uint32: 4,
    float: 4, float32: 4,
    double: 8, float64: 8
  };
  const size = sizes[type];
  if (!size) throw new Error(`Unsupported PLY property type: ${type}`);
  return size;
}

function readPlyValue(view, offset, type) {
  switch (type) {
    case 'char':
    case 'int8':
      return view.getInt8(offset);
    case 'uchar':
    case 'uint8':
      return view.getUint8(offset);
    case 'short':
    case 'int16':
      return view.getInt16(offset, true);
    case 'ushort':
    case 'uint16':
      return view.getUint16(offset, true);
    case 'int':
    case 'int32':
      return view.getInt32(offset, true);
    case 'uint':
    case 'uint32':
      return view.getUint32(offset, true);
    case 'float':
    case 'float32':
      return view.getFloat32(offset, true);
    case 'double':
    case 'float64':
      return view.getFloat64(offset, true);
    default:
      throw new Error(`Unsupported PLY property type: ${type}`);
  }
}
