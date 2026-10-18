import { describe, it, expect } from 'vitest'
import {
  rectangle,
  pixels,
  handles,
  resize,
  toolbarPosition
} from '../../resources/capture/geometry.mjs'
describe('capture coordinates', () => {
  it('normalizes reverse drags and clips selections to the display', () => {
    expect(rectangle({ x: 300, y: 240 }, { x: -30, y: 90 }, 1920, 1080)).toEqual({
      x: 0,
      y: 90,
      width: 300,
      height: 150
    })
  })
  it('maps a fractional DPI region into bounded physical pixels', () => {
    expect(pixels({ x: 100, y: 80, width: 400, height: 300 }, 2400, 1350, 1920, 1080)).toEqual({
      x: 125,
      y: 100,
      width: 500,
      height: 375
    })
    expect(pixels({ x: 1919, y: 1079, width: 10, height: 10 }, 2400, 1350, 1920, 1080)).toEqual({
      x: 2398,
      y: 1348,
      width: 2,
      height: 2
    })
  })
})

describe('selection controls', () => {
  it('provides edge handles and allows crossing the opposite side without moving other axes', () => {
    const crop = { x: 100, y: 80, width: 400, height: 300 }
    expect(handles(crop)).toHaveLength(8)
    expect(handles(crop).find((h) => h.name === 'e')).toMatchObject({ x: 500, y: 230 })
    expect(resize(crop, 'e', { x: 60, y: 999 }, 1920, 1080)).toEqual({
      x: 60,
      y: 80,
      width: 40,
      height: 300
    })
    expect(resize(crop, 'nw', { x: -5, y: -10 }, 1920, 1080)).toEqual({
      x: 0,
      y: 0,
      width: 500,
      height: 380
    })
  })
  it('places controls below the crop, flips at the bottom and clamps on full-screen crops', () => {
    const size = { width: 500, height: 90 }
    expect(toolbarPosition({ x: 100, y: 100, width: 600, height: 400 }, size, 1920, 1080)).toEqual({
      x: 200,
      y: 510,
      above: false
    })
    expect(toolbarPosition({ x: 1700, y: 850, width: 200, height: 200 }, size, 1920, 1080)).toEqual(
      { x: 1400, y: 750, above: true }
    )
    expect(toolbarPosition({ x: 0, y: 0, width: 1920, height: 1080 }, size, 1920, 1080)).toEqual({
      x: 1414,
      y: 984,
      above: false
    })
  })
})
