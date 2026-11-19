/**
 * Collect image files from a drop — including whole folders dragged from the
 * desktop. `DataTransfer.files` only exposes top-level entries, so a dropped
 * directory needs `webkitGetAsEntry()` traversal before its images appear.
 */

export interface DroppedFilesResult {
  files: File[]
  /** True when at least one folder was expanded (callers use this to hint "gallery"). */
  fromFolders: boolean
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const entries: FileSystemEntry[] = []
  // readEntries returns a page at a time (often 100) — keep reading until empty.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject)
    })
    if (!batch.length) break
    entries.push(...batch)
  }
  return entries
}

async function collectFromEntry(
  entry: FileSystemEntry,
  out: File[],
  depth: number,
): Promise<void> {
  if (depth > 8) return
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      ;(entry as FileSystemFileEntry).file(
        (f) => resolve(f),
        () => resolve(null),
      )
    })
    if (file && isImageFile(file)) out.push(file)
    return
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    try {
      const children = await readAllEntries(reader)
      for (const child of children) {
        await collectFromEntry(child, out, depth + 1)
      }
    } catch {
      // Unreadable folder — skip it rather than failing the whole drop.
    }
  }
}

/**
 * Images from a drag's items, expanding folders recursively (breadth-limited).
 * Falls back to `transfer.files` when entries are unavailable (e.g. Firefox).
 */
export async function imageFilesFromDrop(
  transfer: DataTransfer | null | undefined,
): Promise<DroppedFilesResult> {
  if (!transfer) return { files: [], fromFolders: false }

  const items = Array.from(transfer.items ?? [])
  const entries = items
    .map((item) =>
      typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null,
    )
    .filter((entry): entry is FileSystemEntry => !!entry)

  if (entries.length) {
    const files: File[] = []
    let fromFolders = false
    for (const entry of entries) {
      if (entry.isDirectory) fromFolders = true
      await collectFromEntry(entry, files, 0)
    }
    if (files.length || fromFolders) {
      return { files: sortImages(files), fromFolders }
    }
  }

  return {
    files: Array.from(transfer.files ?? []).filter(isImageFile),
    fromFolders: false,
  }
}

/** Deterministic order so a dropped folder becomes a stable gallery. */
function sortImages(files: File[]): File[] {
  return [...files].sort((a, b) => {
    const pathA = (a as File & { webkitRelativePath?: string }).webkitRelativePath || a.name
    const pathB = (b as File & { webkitRelativePath?: string }).webkitRelativePath || b.name
    return pathA.localeCompare(pathB, undefined, { numeric: true, sensitivity: 'base' })
  })
}
