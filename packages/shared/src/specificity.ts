export const SPECIFICITY_CATEGORIES = [
  'coding',
  'web_browsing',
  'data_analysis',
  'image_generation',
  'video_generation',
  'social_media',
  'email_management',
  'calendar_management',
  'trading',
  'private_docs',
] as const;
export type SpecificityCategory = (typeof SPECIFICITY_CATEGORIES)[number];
