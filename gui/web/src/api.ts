export type {
  BootstrapDownload,
  BootstrapFailure,
  BootstrapFailureKind,
  BootstrapHost,
  BootstrapJobSnapshot,
  BootstrapStatus,
  ModelStatus,
  WhisperModelChoice,
} from "./api/bootstrap";
export {
  cancelBootstrap,
  fetchBootstrapJob,
  fetchBootstrapStatus,
  removeBootstrapModel,
  runBootstrap,
  waitForBootstrapJob,
} from "./api/bootstrap";
export type {
  DiagnosticsBundleResult,
  DistributionMetadata,
} from "./api/bootstrapDiagnostics";
export {
  createDiagnosticsBundle,
  fetchDiagnosticsMeta,
  fetchDiagnosticsReportStatus,
  submitDiagnosticsReport,
} from "./api/bootstrapDiagnostics";
export type {
  BoundaryAudioWindow,
  BoundaryAudition,
  BoundaryContext,
  BoundaryEdit,
  BoundaryGeometryClip,
  BoundaryTarget,
} from "./api/boundary";
export {
  auditionBoundary,
  fetchBoundaryAudio,
  loadBoundaryContext,
} from "./api/boundary";
export {
  addCommentReply,
  createComment,
  deleteComment,
  patchComment,
  sendGuestPost,
  setCommentActionDone,
} from "./api/comments";
export type { DawFormat } from "./api/dawExport";
export { loadDawFormats, startDawSession } from "./api/dawExport";
export type {
  DuckingOutcome,
  DuckingPlan,
  DuckingTrackPlan,
} from "./api/documentEdits";
export {
  acceptSessionSuggestionCommand,
  addChapter,
  addSocialClip,
  addTrackCommand,
  applyDuckingCommand,
  applyFadeRecommendations,
  applySuggestedActions,
  approveEdits,
  clearExtractedRoomToneBedCommand,
  clipFadeBaseline,
  correctTranscriptPhrase,
  correctTranscriptWord,
  deleteChapter,
  deleteClips,
  deleteSocialClip,
  duplicateSegment,
  extractRoomToneBedCommand,
  moveClips,
  moveSegment,
  pasteSegment,
  previewDucking,
  proposeSocialClips,
  redoHistory,
  rejectEdits,
  removeTrackCommand,
  renameProjectCommand,
  reorderTrackCommand,
  replyHistoryHead,
  restoreAppliedEdit,
  rippleDeleteClips,
  rollClipJoin,
  selectSessionTakeCommand,
  setClipFade,
  setClipGain,
  setClipJoin,
  setClipsFade,
  setClipsGain,
  setEffectBypass,
  setEnvelope,
  setJoinFadeLimitCommand,
  setRecordSessionNameCommand,
  setTrackFaderCommand,
  setTrackMediaCommand,
  setTrackMetaCommand,
  setTrackMuteCommand,
  setTranscriptWordAutomatic,
  setTranscriptWordSuppressed,
  setTranscriptWordsIgnored,
  skipSessionSuggestionCommand,
  splitAtTime,
  submitDocumentCommand,
  trimClipEdge,
  undoHistory,
  updateChapter,
  updatePendingEdit,
  updateSocialClip,
  updateSocialClipDetails,
  waiveTranscriptRefine,
} from "./api/documentEdits";
export { getEditorCutTotal } from "./api/editImpact";
export type { ExportEvidence } from "./api/exportEvidence";
export { parseExportEvidence } from "./api/exportEvidence";
export type {
  ExportArchiveEntry,
  ExportedFileEntry,
  ExportedFileKind,
  ExportedInventory,
  ExportedTranscriptFormat,
} from "./api/exportedFiles";
export {
  exportedArchiveHref,
  exportedFileHref,
  listExportedFiles,
  readGuestExportedFiles,
  revealExportedFile,
} from "./api/exportedFiles";
export type { ExportFormats } from "./api/exportJobs";
export {
  bounceAudio,
  exportDeliverables,
  readExportSettings,
  startBounceJob,
  startExportJob,
} from "./api/exportJobs";
export { loadFeed, sendFeedEdit, sendFeedWrite } from "./api/feed";
export type { HostMcpActivity } from "./api/hostMcp";
export { fetchHostMcpActivity } from "./api/hostMcp";
export {
  apiSend,
  HOST_KEY,
  isHostProjectKey,
  NETWORK_ERROR_CODE,
} from "./api/http";
export { openJobStream } from "./api/jobStream";
export type {
  DamagedKitRow,
  KitApplyReport,
  KitFileDownload,
  KitImportEntry,
  KitImportIncompleteBody,
  KitImportOutcome,
  KitImportPreview,
  KitImportResult,
  KitListRow,
  KitOffer,
  KitOfferEntry,
  KitOfferKit,
  KitRow,
  KitSaveEntry,
  KitSaveRefusal,
  KitSaveRequest,
  KitSaveResult,
} from "./api/kits";
export {
  applyKit,
  cancelKitImport,
  commitKitImport,
  downloadKitFile,
  isDamagedKit,
  KIT_IMPORT_RETRY_CODES,
  KIT_TOO_LARGE_MESSAGE,
  kitSaveRefusal,
  loadKitOffer,
  loadKits,
  partialImport,
  previewKitImport,
  saveKit,
} from "./api/kits";
export {
  isDeadLinkAnswer,
  isLinkEnded,
  markLinkEnded,
  reportLinkDoubt,
  subscribeLinkDoubt,
} from "./api/linkState";
export {
  audioUrl,
  loadProxyManifest,
  loadSessionMeta,
  loadSessionState,
  postSessionState,
} from "./api/mediaSession";
export type {
  StaleTrack,
  TranscriptLanguageStatus,
  TranscriptVocabulary,
} from "./api/pipeline";
export {
  cancelPipelineRun,
  enqueueSetupRun,
  followExportJob,
  followJobToOk,
  guestExportFailed,
  JobCancelledError,
  jobFailure,
  loadPipelineConfig,
  loadPipelineStatus,
  loadPipelineSteps,
  loadTranscriptLanguageStatus,
  loadTranscriptVocabulary,
  pipelineEventsUrl,
  putPipelineConfig,
  retryPipelineJob,
  saveTranscriptVocabulary,
  startGuestExport,
  startPipelineRun,
  startRenderPreview,
  waitForPipelineJob,
} from "./api/pipeline";
export type {
  MediaUploadResult,
  PickEpisodeProjectResult,
  RecentProject,
  ReviewVersionStatus,
} from "./api/project";
export {
  closeEpisodeProject,
  createEpisodeProject,
  duplicateRecentProject,
  forgetRecentProject,
  isFrozenReviewKey,
  listRecentProjects,
  loadDocumentState,
  loadHistoryDiff,
  loadProjectMeta,
  loadReviewBootstrap,
  loadReviewVersionStatus,
  moveProject,
  openEpisodeProject,
  pickEpisodeProject,
  pickFolder,
  revealProject,
  revealRecentProject,
  reviewVersionAtBootstrap,
  uploadMediaFile,
} from "./api/project";
export {
  cachedReviewPeaks,
  clearReviewPeaksCache,
  loadReviewPeaks,
} from "./api/reviewPeaks";
export type {
  DamagedSegmentRow,
  SegmentClipRow,
  SegmentFileDownload,
  SegmentImportOutcome,
  SegmentImportPreview,
  SegmentInsertApplied,
  SegmentInsertAt,
  SegmentInsertOutcome,
  SegmentInsertPreview,
  SegmentInsertRefusal,
  SegmentInsertRequest,
  SegmentKind,
  SegmentListRow,
  SegmentPlacement,
  SegmentRow,
  SegmentSaveRefusal,
  SegmentSaveRequest,
  SegmentSaveResult,
} from "./api/segments";
export {
  cancelSegmentImport,
  commitSegmentImport,
  downloadSegmentFile,
  insertSegment,
  isDamagedSegment,
  loadSegments,
  previewSegmentImport,
  previewSegmentInsert,
  removeSegment,
  saveSegment,
  segmentAudioUrl,
  segmentInsertRefusal,
  segmentSaveRefusal,
  stagedClipUrl,
} from "./api/segments";
export {
  loadSessionTakes,
  type SessionTakeDetail,
  type SessionTakeRefusal,
  type SessionTakes,
} from "./api/sessionTakes";
export type {
  HostRevoked,
  HostRevokeOptions,
  RestoreRefusalCode,
} from "./api/sharesRecord";
export {
  createHostRecordRoom,
  createHostShare,
  hostLandRecord,
  hostRecordUploadTransport,
  listHostShares,
  loadHostRecordSessions,
  loadHostRecordState,
  postHostRecordCommand,
  replaceHostRecordInvite,
  restoreHostRoom,
  restoreHostShare,
  restoreRefusal,
  revokeHostRoom,
  revokeHostShare,
} from "./api/sharesRecord";
export type { SplitSpeakersRequest } from "./api/speakerSplit";
export { startSplitSpeakersJob } from "./api/speakerSplit";
export type {
  TranscriptExportFile,
  TranscriptExportResult,
  TranscriptFormat,
  TranscriptPreviewTurn,
} from "./api/transcript";
export { exportTranscript } from "./api/transcript";
export {
  loadTranscriptCheck,
  markTranscriptChecked,
} from "./api/transcriptCheck";
export type {
  TranscriptReplacementOptions,
  TranscriptReplacementPreview,
} from "./api/transcriptReplace";
export {
  previewTranscriptReplacement,
  replaceTranscriptMatches,
} from "./api/transcriptReplace";
export type { WaveformSnapPayload } from "./api/waveform";
export {
  loadWaveformPcm,
  loadWaveformSnap,
  loadWaveformStatus,
  loadWaveformTiles,
  WaveformFetchError,
} from "./api/waveform";
