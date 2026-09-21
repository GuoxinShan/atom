/**
 * Extract-facing helpers for the closed Laya theme/project vocabulary.
 * Product edits live in `data/theme-vocabulary.json`.
 */

export {
  TAG_NONE,
  TAG_OTHER,
  THEME_VOCABULARY_FILE,
  DEFAULT_THEME_VOCABULARY,
  DEFAULT_THEME_LABELS,
  DEFAULT_PROJECT_LABELS,
  collectTagLabels,
  loadThemeVocabulary,
  mapToAllowlist,
  normalizeProject,
  normalizeTheme,
  tagLabelsForExtract,
  tryMapAllowlist,
  type ExtractTagLabels,
  type ThemeLabel,
  type ThemeVocabulary,
} from "./theme-vocabulary.js";
