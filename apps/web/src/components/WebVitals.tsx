'use client';

import { useReportWebVitals } from 'next/web-vitals';

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

/**
 * Mesure des Core Web Vitals (LCP, CLS, INP, TTFB…). Envoie à GA4 quand
 * gtag est présent (branché à la tâche 01/25); trace en console en dev.
 * Zéro dépendance — le hook de Next embarque web-vitals.
 */
export function WebVitals() {
  useReportWebVitals((metric) => {
    if (typeof window.gtag === 'function') {
      window.gtag('event', metric.name, {
        value: Math.round(metric.name === 'CLS' ? metric.value * 1000 : metric.value),
        metric_id: metric.id,
        metric_rating: metric.rating,
        non_interaction: true,
      });
    } else if (process.env.NODE_ENV === 'development') {
      console.debug(
        '[web-vitals]',
        metric.name,
        Math.round(metric.value * 100) / 100,
        metric.rating,
      );
    }
  });
  return null;
}
