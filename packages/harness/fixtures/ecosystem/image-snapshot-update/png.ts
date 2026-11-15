// A PNG encoder for the image fixtures, so no binary file is committed (D13): 8-bit RGBA, one
// filter byte (none) per row, the rows deflated with node:zlib.
import { crc32, deflateSync } from 'node:zlib'

type Pixel = readonly [number, number, number, number]

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A `width` by `height` PNG whose pixel at (x, y) is `pixel(x, y)`. */
export function png(width: number, height: number, pixel: (x: number, y: number) => Pixel): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  const rowLength = width * 4 + 1
  const raw = Buffer.alloc(rowLength * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * rowLength + 1 + x * 4)
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export const RED: Pixel = [255, 0, 0, 255]
export const BLUE: Pixel = [0, 0, 255, 255]
export const GREEN: Pixel = [0, 255, 0, 255]
