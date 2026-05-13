import { describe, it, expect } from 'vitest'
import {
  formatIdleSeconds,
  renderWhoTable,
} from '../components/ChatPanel'

describe('formatIdleSeconds', () => {
  it('renders sub-minute idle as bare seconds', () => {
    expect(formatIdleSeconds(0)).toBe('0s')
    expect(formatIdleSeconds(53)).toBe('53s')
    expect(formatIdleSeconds(59)).toBe('59s')
  })

  it('renders ≥1 min as "Nm  Ss" with a leading-space-padded second', () => {
    // Single-digit second left-padded with a space so columns
    // line up with two-digit-second rows.
    expect(formatIdleSeconds(63)).toBe('1m  3s')
    expect(formatIdleSeconds(214)).toBe('3m 34s')
    expect(formatIdleSeconds(635)).toBe('10m 35s')
  })

  it('floors fractional seconds and clamps negatives to 0', () => {
    expect(formatIdleSeconds(3.9)).toBe('3s')
    expect(formatIdleSeconds(-10)).toBe('0s')
  })
})

describe('renderWhoTable', () => {
  it('formats the spec example header, rows, and footer', () => {
    const now = Date.now()
    const out = renderWhoTable(
      [
        {
          username: 'kig',
          state: 'ai-battle',
          opponent_username: null,
          last_seen_at: new Date(now - 53_000).toISOString(),
        },
        {
          username: 'kate',
          state: 'human-battle',
          opponent_username: 'bob',
          last_seen_at: new Date(now - 63_000).toISOString(),
        },
        {
          username: 'bob',
          state: 'human-battle',
          opponent_username: 'kate',
          last_seen_at: new Date(now - 214_000).toISOString(),
        },
        {
          username: 'john1',
          state: 'idle',
          opponent_username: null,
          last_seen_at: new Date(now - 635_000).toISOString(),
        },
      ],
      4,
      0,
      10,
    )
    const lines = out.split('\n')
    expect(lines[0]).toMatch(/^Currently Online:\s+Page 1 of 1$/)
    // Divider lines are em-dashes spanning the content width.
    expect(lines[1]).toMatch(/^—+$/)
    expect(lines[2]).toMatch(/^ {2}@kig\s+\d+s idle: playing AI$/)
    expect(lines[3]).toMatch(/^ {2}@kate\s+1m\s+\d+s idle: playing @bob$/)
    expect(lines[4]).toMatch(/^ {2}@bob\s+3m \d+s idle: playing @kate$/)
    expect(lines[5]).toMatch(/^ {2}@john1\s+10m \d+s idle: inactive$/)
    expect(lines[6]).toMatch(/^—+$/)
    expect(lines[7]).toBe('Total Currently Online: 4')
  })

  it('shows "(nobody is online right now)" when the page is empty', () => {
    const out = renderWhoTable([], 0, 0, 10)
    expect(out).toMatch(/Currently Online:\s+Page 1 of 1/)
    expect(out).toMatch(/\(nobody is online right now\)/)
    expect(out).toMatch(/Total Currently Online: 0/)
  })

  it('derives the current page from offset and per-page', () => {
    // (users, total, offset, perPage): total 47 / per-page 10 → 5 pages;
    // offset 30 sits in page 4.
    const out = renderWhoTable([], 47, 30, 10)
    expect(out).toMatch(/Page 4 of 5/)
  })

  it('renders chatting state as inactive (it is not a /who-spec label)', () => {
    const out = renderWhoTable(
      [
        {
          username: 'a',
          state: 'chatting',
          opponent_username: null,
          last_seen_at: new Date().toISOString(),
        },
      ],
      1,
      0,
      10,
    )
    expect(out).toMatch(/@a\s+\d+s idle: inactive/)
  })
})
