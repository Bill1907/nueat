import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';

import { isUploadDraftExpired } from '@/uploads/image-upload-policy';

const DRAFT_DIRECTORY_NAME = 'meal-upload-drafts';
const DRAFT_METADATA_NAME = 'current.json';

export interface LocalImageUploadDraft {
  version: 1;
  id: string;
  fileUri: string;
  contentType: 'image/jpeg';
  byteSize: number;
  width: number;
  height: number;
  source: 'camera' | 'library';
  createdAt: string;
  validatedAssetId?: string;
}

export async function persistLocalUploadDraft(input: {
  cacheUri: string;
  byteSize: number;
  width: number;
  height: number;
  source: LocalImageUploadDraft['source'];
}) {
  const directory = draftDirectory();
  directory.create({ idempotent: true, intermediates: true });
  clearDirectory(directory);

  const id = randomUUID();
  const destination = new File(directory, `${id}.jpg`);
  await new File(input.cacheUri).copy(destination, { overwrite: true });
  const draft: LocalImageUploadDraft = {
    version: 1,
    id,
    fileUri: destination.uri,
    contentType: 'image/jpeg',
    byteSize: input.byteSize,
    width: input.width,
    height: input.height,
    source: input.source,
    createdAt: new Date().toISOString(),
  };
  writeMetadata(draft);
  return draft;
}

export function markLocalUploadDraftValidated(
  draft: LocalImageUploadDraft,
  validatedAssetId: string,
) {
  const updated = { ...draft, validatedAssetId };
  writeMetadata(updated);
  return updated;
}

export async function loadLocalUploadDraft() {
  const metadata = new File(draftDirectory(), DRAFT_METADATA_NAME);
  if (!metadata.exists) return null;

  try {
    const draft = parseDraft(await metadata.text());
    const image = new File(draft.fileUri);
    if (
      !image.exists ||
      image.size !== draft.byteSize ||
      isUploadDraftExpired(draft.createdAt)
    ) {
      await removeLocalUploadDraft();
      return null;
    }
    return draft;
  } catch {
    await removeLocalUploadDraft();
    return null;
  }
}

export async function removeLocalUploadDraft() {
  const directory = draftDirectory();
  if (!directory.exists) return;
  directory.delete();
}
function writeMetadata(draft: LocalImageUploadDraft) {
  const directory = draftDirectory();
  directory.create({ idempotent: true, intermediates: true });
  const metadata = new File(directory, DRAFT_METADATA_NAME);
  metadata.create({ overwrite: true });
  metadata.write(JSON.stringify(draft));
}

function draftDirectory() {
  return new Directory(Paths.document, DRAFT_DIRECTORY_NAME);
}

function clearDirectory(directory: Directory) {
  for (const entry of directory.list()) entry.delete();
}

function parseDraft(value: string): LocalImageUploadDraft {
  const candidate = JSON.parse(value) as Partial<LocalImageUploadDraft>;
  if (
    candidate.version !== 1 ||
    typeof candidate.id !== 'string' ||
    typeof candidate.fileUri !== 'string' ||
    candidate.contentType !== 'image/jpeg' ||
    typeof candidate.byteSize !== 'number' ||
    typeof candidate.width !== 'number' ||
    typeof candidate.height !== 'number' ||
    (candidate.source !== 'camera' && candidate.source !== 'library') ||
    typeof candidate.createdAt !== 'string' ||
    (candidate.validatedAssetId !== undefined &&
      typeof candidate.validatedAssetId !== 'string')
  ) {
    throw new Error('Invalid local upload draft');
  }
  return candidate as LocalImageUploadDraft;
}
