# Cell Protocol v2

> Status: implemented

Cell protocol v2 keeps TmuxGo's existing snapshot/diff state-synchronization model while making the character payload grapheme-aware.

The design follows two established terminal ideas:

- terminal state comes from a real terminal emulator (`@xterm/headless`), rather than reconstructing VT state in the transport layer;
- screen synchronization carries cells plus explicit display width, similar to libvterm-style screen cells, while `seq` / `baseSeq` continue to provide snapshot/diff resynchronization semantics.

## Compatibility

Cell v1 remains supported. v2 has separate outer binary frame type codes, so a future capability negotiation can select v2 without changing or ambiguously reinterpreting v1 payloads.

| Type code | Meaning |
| ---: | --- |
| 9 | `cell_snapshot_v2` |
| 10 | `cell_snapshot_v2_gzip` |
| 11 | `cell_diff_v2` |
| 12 | `cell_diff_v2_gzip` |

The current runtime does not advertise or activate v2 yet. This document specifies the codec introduced before transport negotiation is enabled.

## Cell model

Each v2 cell carries:

- `text`: UTF-8 terminal cell text; may contain multiple Unicode code points (for example `e` + combining acute accent);
- `width`: terminal display width `0`, `1`, or `2`;
- `attr`: packed style/color-mode bits;
- `fg`: foreground color value;
- `bg`: background color value.

A width-0 cell is the continuation half of a wide cell and carries an empty text payload. A width-2 lead cell carries the complete grapheme text and is followed by a width-0 continuation cell in the screen grid.

## Snapshot payload

Header, 20 bytes:

```text
u16 cols
u16 rows
u16 cursorX
u16 cursorY
u16 flags
u16 reserved
u32 seq
u32 runCount
```

Each RLE run:

```text
u16 runLen
u8  width
u8  reserved
u16 textByteLength
u32 attr
u32 fg
u32 bg
u8[textByteLength] utf8Text
```

Runs are equal only when `text`, `width`, `attr`, `fg`, and `bg` are equal.

## Diff payload

Header, 20 bytes:

```text
u32 seq
u32 baseSeq
u16 cursorX
u16 cursorY
u16 flags
u16 reserved
u32 changeCount
```

Each changed cell:

```text
u16 x
u16 y
u8  width
u8  reserved
u16 textByteLength
u32 attr
u32 fg
u32 bg
u8[textByteLength] utf8Text
```

`baseSeq` must match the receiver's current state sequence before applying a diff. A mismatch requires a full snapshot/resync instead of attempting to apply the diff.

## Rendering note

The browser still renders through xterm. When reconstructing ANSI for the current experimental client path, width-0 continuation cells must be skipped rather than replaced with a space; the width-2 lead grapheme already advances the terminal cursor by two columns.
