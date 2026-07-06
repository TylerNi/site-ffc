import { notFound } from 'next/navigation';

/** Attrape-tout : toute URL hors des routes connues → 404 localisée. */
export default function CatchAllPage() {
  notFound();
}
