import type { Agent } from '@atproto/api'
import * as TID from '@atcute/tid'
import { blobRefToJson } from '@/lib/atproto/blobs'
import { resolvePdsUrl } from '@/lib/atproto/pds'
import { buildBlobUrl } from '@/lib/atproto/blobs'
import { COLLECTIONS } from '@/lib/lichen/collections'
import { listRecords, parseAtUri } from '@/lib/atproto/lichen'
import type {
  LichenApprovedMediaRecord,
  LichenPageGrantRecord,
  LichenPolicyRecord,
  LichenSuggestionRecord,
  PageGrantRole,
  SuggestionKind,
  SuggestionStatus,
  WikiEditAccess,
  WikiImageMode,
} from '@/types/lichen'

type RecordValue = Record<string, unknown>

function typedRecord(collection: string, fields: RecordValue): RecordValue {
  return { $type: collection, ...fields }
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export async function listPolicies(agent: Agent, did: string): Promise<LichenPolicyRecord[]> {
  return listRecords(agent, did, COLLECTIONS.policy, (uri, cid, _rkey, value) => ({
    uri,
    cid,
    wikiRef: String(value.wikiRef ?? ''),
    createdAt: String(value.createdAt ?? new Date().toISOString()),
    editAccess: value.editAccess as LichenPolicyRecord['editAccess'],
    suggestionsEnabled: value.suggestionsEnabled as boolean | undefined,
    imageMode: value.imageMode as LichenPolicyRecord['imageMode'],
    imageSubmissions: value.imageSubmissions as boolean | undefined,
    forumEnabled: value.forumEnabled as boolean | undefined,
    forumThreads: value.forumThreads as LichenPolicyRecord['forumThreads'],
    forumMods: Array.isArray(value.forumMods)
      ? value.forumMods.filter((m): m is string => typeof m === 'string')
      : undefined,
    forumHiddenPosts: Array.isArray(value.forumHiddenPosts)
      ? value.forumHiddenPosts.filter((p): p is string => typeof p === 'string')
      : undefined,
  }))
}

export interface PolicyFields {
  editAccess?: WikiEditAccess
  suggestionsEnabled?: boolean
  imageMode?: WikiImageMode
  imageSubmissions?: boolean
  forumEnabled?: boolean
  forumThreads?: LichenPolicyRecord['forumThreads']
  forumMods?: string[]
  forumHiddenPosts?: string[]
}

export async function writePolicyRecord(
  agent: Agent,
  wikiRef: string,
  fields: PolicyFields,
  rkey = TID.now().toString(),
  repoDid?: string,
): Promise<LichenPolicyRecord> {
  const createdAt = new Date().toISOString()
  const record = typedRecord(COLLECTIONS.policy, {
    wikiRef,
    createdAt,
    ...(fields.editAccess ? { editAccess: fields.editAccess } : {}),
    ...(fields.suggestionsEnabled !== undefined
      ? { suggestionsEnabled: fields.suggestionsEnabled }
      : {}),
    ...(fields.imageMode ? { imageMode: fields.imageMode } : {}),
    ...(fields.imageSubmissions !== undefined
      ? { imageSubmissions: fields.imageSubmissions }
      : {}),
    ...(fields.forumEnabled !== undefined ? { forumEnabled: fields.forumEnabled } : {}),
    ...(fields.forumThreads ? { forumThreads: fields.forumThreads } : {}),
    ...(fields.forumMods !== undefined ? { forumMods: [...fields.forumMods] } : {}),
    ...(fields.forumHiddenPosts !== undefined
      ? { forumHiddenPosts: [...fields.forumHiddenPosts] }
      : {}),
  })

  const response = await agent.com.atproto.repo.putRecord({
    repo: repoDid ?? agent.accountDid,
    collection: COLLECTIONS.policy,
    rkey,
    record: record as RecordValue,
  })

  return {
    uri: response.data.uri,
    cid: response.data.cid,
    wikiRef,
    createdAt,
    ...fields,
  }
}

export async function deletePolicyRecord(agent: Agent, policyUri: string): Promise<void> {
  const parsed = parseAtUri(policyUri)
  if (!parsed) return
  await agent.com.atproto.repo.deleteRecord({
    repo: parsed.did,
    collection: COLLECTIONS.policy,
    rkey: parsed.rkey,
  })
}

/** Overwrite an existing policy record in place, keeping its rkey and createdAt. */
export async function updatePolicyRecord(
  agent: Agent,
  policy: LichenPolicyRecord,
  fields: PolicyFields,
): Promise<LichenPolicyRecord> {
  const parsed = parseAtUri(policy.uri)
  if (!parsed) throw new Error('Invalid policy URI')
  return writePolicyRecord(
    agent,
    policy.wikiRef,
    { ...fields },
    parsed.rkey,
    parsed.did,
  ).then((updated) => ({ ...updated, createdAt: policy.createdAt }))
}

// ---------------------------------------------------------------------------
// Page grants
// ---------------------------------------------------------------------------

export async function listPageGrants(agent: Agent, did: string): Promise<LichenPageGrantRecord[]> {
  return listRecords(agent, did, COLLECTIONS.pageGrant, (uri, cid, _rkey, value) => ({
    uri,
    cid,
    wikiRef: String(value.wikiRef ?? ''),
    noteSlug: String(value.noteSlug ?? ''),
    memberDid: String(value.memberDid ?? ''),
    role: (value.role as PageGrantRole) ?? 'suggester',
    createdAt: String(value.createdAt ?? new Date().toISOString()),
  }))
}

export async function writePageGrantRecord(
  agent: Agent,
  wikiRef: string,
  noteSlug: string,
  memberDid: string,
  role: PageGrantRole,
  rkey = TID.now().toString(),
  repoDid?: string,
): Promise<LichenPageGrantRecord> {
  const createdAt = new Date().toISOString()
  const record = typedRecord(COLLECTIONS.pageGrant, {
    wikiRef,
    noteSlug,
    memberDid,
    role,
    createdAt,
  })

  const response = await agent.com.atproto.repo.putRecord({
    repo: repoDid ?? agent.accountDid,
    collection: COLLECTIONS.pageGrant,
    rkey,
    record: record as RecordValue,
  })

  return {
    uri: response.data.uri,
    cid: response.data.cid,
    wikiRef,
    noteSlug,
    memberDid,
    role,
    createdAt,
  }
}

export async function deletePageGrantRecord(agent: Agent, grantUri: string): Promise<void> {
  const parsed = parseAtUri(grantUri)
  if (!parsed) return
  await agent.com.atproto.repo.deleteRecord({
    repo: parsed.did,
    collection: COLLECTIONS.pageGrant,
    rkey: parsed.rkey,
  })
}

// ---------------------------------------------------------------------------
// Suggestions (stored in the author's own repo)
// ---------------------------------------------------------------------------

export interface SuggestionInput {
  wikiRef: string
  noteSlug: string
  kind: SuggestionKind
  content?: string
  title?: string
  baseRevision?: string
  message?: string
  blobs?: Array<Record<string, unknown>>
  alt?: string
}

export async function writeSuggestionRecord(
  agent: Agent,
  input: SuggestionInput,
  rkey = TID.now().toString(),
): Promise<LichenSuggestionRecord> {
  const createdAt = new Date().toISOString()
  const blobs = (input.blobs ?? [])
    .map((item) => blobRefToJson(item))
    .filter((item): item is Record<string, unknown> => !!item)
  const record = typedRecord(COLLECTIONS.suggestion, {
    wikiRef: input.wikiRef,
    noteSlug: input.noteSlug,
    kind: input.kind,
    createdAt,
    status: 'pending' satisfies SuggestionStatus,
    ...(input.content ? { content: input.content } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.baseRevision ? { baseRevision: input.baseRevision } : {}),
    ...(input.message ? { message: input.message } : {}),
    ...(blobs.length ? { blobs } : {}),
    ...(input.alt ? { alt: input.alt } : {}),
  })

  const response = await agent.com.atproto.repo.putRecord({
    repo: agent.accountDid,
    collection: COLLECTIONS.suggestion,
    rkey,
    record: record as RecordValue,
  })

  return {
    uri: response.data.uri,
    cid: response.data.cid,
    authorDid: agent.accountDid,
    wikiRef: input.wikiRef,
    noteSlug: input.noteSlug,
    kind: input.kind,
    content: input.content,
    title: input.title,
    baseRevision: input.baseRevision,
    message: input.message,
    blobs: blobs.length ? blobs : undefined,
    alt: input.alt,
    status: 'pending',
    createdAt,
  }
}

/** Authors can withdraw (or locally mirror a review outcome) on their own records. */
export async function updateSuggestionStatus(
  agent: Agent,
  suggestion: LichenSuggestionRecord,
  status: SuggestionStatus,
): Promise<void> {
  const parsed = parseAtUri(suggestion.uri)
  if (!parsed || parsed.did !== agent.accountDid) return
  const record = typedRecord(COLLECTIONS.suggestion, {
    wikiRef: suggestion.wikiRef,
    noteSlug: suggestion.noteSlug,
    kind: suggestion.kind,
    createdAt: suggestion.createdAt,
    status,
    ...(suggestion.content ? { content: suggestion.content } : {}),
    ...(suggestion.title ? { title: suggestion.title } : {}),
    ...(suggestion.baseRevision ? { baseRevision: suggestion.baseRevision } : {}),
    ...(suggestion.message ? { message: suggestion.message } : {}),
    ...(suggestion.blobs?.length
      ? {
          blobs: suggestion.blobs
            .map((item) => blobRefToJson(item))
            .filter((item): item is Record<string, unknown> => !!item),
        }
      : {}),
    ...(suggestion.alt ? { alt: suggestion.alt } : {}),
  })
  await agent.com.atproto.repo.putRecord({
    repo: parsed.did,
    collection: COLLECTIONS.suggestion,
    rkey: parsed.rkey,
    record: record as RecordValue,
  })
}

// ---------------------------------------------------------------------------
// Approved media
// ---------------------------------------------------------------------------

export async function listApprovedMedia(
  agent: Agent,
  did: string,
): Promise<LichenApprovedMediaRecord[]> {
  return listRecords(
    agent,
    did,
    COLLECTIONS.approvedMedia,
    (uri, cid, _rkey, value) => ({
      uri,
      cid,
      wikiRef: String(value.wikiRef ?? ''),
      imageCid: String(value.imageCid ?? ''),
      blob: value.blob,
      mimeType: value.mimeType as string | undefined,
      alt: value.alt as string | undefined,
      addedBy: value.addedBy as string | undefined,
      source: value.source as LichenApprovedMediaRecord['source'],
      createdAt: String(value.createdAt ?? new Date().toISOString()),
    }),
  )
}

export async function writeApprovedMediaRecord(
  agent: Agent,
  wikiRef: string,
  imageCid: string,
  options: {
    blob?: unknown
    mimeType?: string
    alt?: string
    addedBy?: string
    source?: 'owner' | 'submission'
  } = {},
  rkey = TID.now().toString(),
  repoDid?: string,
): Promise<LichenApprovedMediaRecord> {
  const createdAt = new Date().toISOString()
  const blob = blobRefToJson(options.blob)
  const record = typedRecord(COLLECTIONS.approvedMedia, {
    wikiRef,
    imageCid,
    createdAt,
    ...(blob ? { blob } : {}),
    ...(options.mimeType ? { mimeType: options.mimeType } : {}),
    ...(options.alt ? { alt: options.alt } : {}),
    ...(options.addedBy ? { addedBy: options.addedBy } : {}),
    ...(options.source ? { source: options.source } : {}),
  })

  const response = await agent.com.atproto.repo.putRecord({
    repo: repoDid ?? agent.accountDid,
    collection: COLLECTIONS.approvedMedia,
    rkey,
    record: record as RecordValue,
  })

  return {
    uri: response.data.uri,
    cid: response.data.cid,
    wikiRef,
    imageCid,
    blob: blob ?? undefined,
    mimeType: options.mimeType,
    alt: options.alt,
    addedBy: options.addedBy,
    source: options.source,
    createdAt,
  }
}

export async function deleteApprovedMediaRecord(agent: Agent, mediaUri: string): Promise<void> {
  const parsed = parseAtUri(mediaUri)
  if (!parsed) return
  await agent.com.atproto.repo.deleteRecord({
    repo: parsed.did,
    collection: COLLECTIONS.approvedMedia,
    rkey: parsed.rkey,
  })
}

// ---------------------------------------------------------------------------
// Blob transfer — pull a contributor's blob and re-upload it as the owner
// ---------------------------------------------------------------------------

/** Download a public blob from the DID's PDS. */
export async function fetchBlobBytes(did: string, cid: string): Promise<Uint8Array> {
  const pdsUrl = await resolvePdsUrl(did)
  const url = buildBlobUrl(pdsUrl, did, cid)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Could not fetch the submitted image (${response.status})`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

/** Upload raw bytes to the signed-in user's repo; returns the new blob ref JSON. */
export async function uploadBlobBytes(
  agent: Agent,
  bytes: Uint8Array,
  mimeType: string,
): Promise<Record<string, unknown>> {
  const response = await agent.com.atproto.repo.uploadBlob(
    bytes as unknown as Blob,
    { encoding: mimeType || 'application/octet-stream' },
  )
  return blobRefToJson(response.data.blob) ?? {}
}

/**
 * Copy a blob from one repo into the signed-in user's repo. Returns the new
 * CID plus the blob ref to embed in records written to the caller's repo.
 */
export async function transferBlob(
  agent: Agent,
  fromDid: string,
  blobRef: unknown,
  fallbackCid?: string,
): Promise<{ imageCid: string; blob: Record<string, unknown> }> {
  const json = blobRefToJson(blobRef)
  const cid =
    (json?.ref as { $link?: string } | undefined)?.$link ?? fallbackCid ?? ''
  if (!cid) throw new Error('Submitted image has no readable blob reference')

  const mimeType = (json?.mimeType as string | undefined) ?? 'image/png'
  const bytes = await fetchBlobBytes(fromDid, cid)
  const blob = await uploadBlobBytes(agent, bytes, mimeType)
  const newCid = (blob.ref as { $link?: string } | undefined)?.$link ?? ''
  return { imageCid: newCid || cid, blob }
}
