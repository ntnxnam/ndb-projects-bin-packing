/**
 * Sizing bands: label → "up to" months (duration for Gantt bar length).
 * Used by both data prep and the app for consistency.
 */
export const SIZING_MONTHS = {
  'None': 0,
  'XS (1 month)': 1,
  'S (1-3 months)': 3,
  'M (3-5 months)': 5,
  'L (5-8 months)': 8,
  'XL (8-13 months)': 13,
  'XXL (13+ months)': 21,
  '3L (21+ months)': 34,
  '4L (34+ months)': 55,
};

export function durationMonths(project) {
  return project.durationMonths ?? 0;
}

export function totalResources(project) {
  const r = project.totalResources;
  return typeof r === 'number' && r > 0 ? r : 0;
}
