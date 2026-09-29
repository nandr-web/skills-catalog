// The hosted catalog's adapters (contract §7): DynamoDB and S3 behind the core's ports, plus the upload links only a
// hosted catalog has.
export { HostedStorage, type HostedParts } from './storage.ts';
export { HostedEvents } from './events.ts';
export { S3SearchIndex } from './search.ts';
export { HostedBlobLinks, LINK_SECONDS, type UploadAnswer } from './links.ts';
export { HostedSweep } from './sweep.ts';
export { HostedFileNames, fileNamePk, namesClient, namesIndexer } from './names.ts';
export { fileState, type FileState } from './api/files.ts';
export { HostedTokenStore, type TokenHolder, type TokenKind, type TokenScope } from './tokens.ts';
export { COMMIT_AGE_MS, MARK_WAIT_MS, SWEEP_AGE_MS, ageOf, committable, inspect } from './blobs.ts';
export { BLOB_PREFIX, SEARCH_KEY, blobKey, createStores, versionSk, type Place } from './place.ts';
export { createHostedHandler, type HostedHandlerParts, type HostedRequest } from './api/handler.ts';
export { lambdaAdapter, type HttpApiEvent, type HttpApiResult } from './api/lambda.ts';
export { mayRun, whoIsAsking, type Asking } from './api/who.ts';
export { ORIGIN_HEADER, ORIGIN_VALUES_MS, originGuard, type OriginGuard } from './api/origin.ts';
