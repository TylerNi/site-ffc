import { Injectable, Logger } from '@nestjs/common';
import { type AiAnalysisMode, type VisionExtraction } from '@ffc/core';
import {
  type VisionAnalysis,
  type VisionInput,
  type VisionProvider,
  VisionProviderError,
} from './vision-provider';

/**
 * Driver `log` — fixture DÉTERMINISTE pour dev/test (aucun réseau, aucune
 * clé). Les fixtures par défaut sont alignées sur le seed : en dev, n'importe
 * quelle photo aboutit à un parcours complet crédible (correspondance
 * d'équipement, variantes proposées). Les tests pilotent les cas limites via
 * `stage()` (résultat ou erreur, consommés en FIFO) et comptent les appels
 * réellement facturables via `calls` (critère « jamais de double facturation »).
 */
@Injectable()
export class LogVisionProvider implements VisionProvider {
  readonly name = 'log';
  readonly model = 'fixture-deterministe';
  private readonly logger = new Logger(LogVisionProvider.name);

  /** Nombre d'analyses exécutées (assertions d'idempotence des tests). */
  calls = 0;

  private staged: Array<{ extraction: VisionExtraction } | { error: VisionProviderError }> = [];

  /** Programme le résultat de la PROCHAINE analyse (FIFO). */
  stage(extraction: VisionExtraction): void {
    this.staged.push({ extraction });
  }

  /** Programme un échec pour la PROCHAINE analyse (FIFO). */
  stageError(message: string, retryable: boolean): void {
    this.staged.push({ error: new VisionProviderError(message, this.name, retryable) });
  }

  isConfigured(): boolean {
    return true;
  }

  async analyze(input: VisionInput): Promise<VisionAnalysis> {
    this.calls += 1;
    const staged = this.staged.shift();
    if (staged && 'error' in staged) throw staged.error;

    const extraction = staged?.extraction ?? defaultFixtureFor(input.mode);
    this.logger.log(`[vision simulée] mode ${input.mode} (${input.image.length} octets).`);
    return {
      extraction,
      provider: this.name,
      model: this.model,
      latencyMs: 12,
      usage: { inputTokens: 1500, outputTokens: 250 },
    };
  }
}

/** Fixtures alignées sur le seed (Lennox G61MPV ; filtres 16x25x1 MERV 11). */
function defaultFixtureFor(mode: AiAnalysisMode): VisionExtraction {
  if (mode === 'EQUIPMENT_LABEL') {
    return {
      manufacturer: { value: 'Lennox', confidence: 0.95 },
      modelNumber: { value: 'G61MPV-36B-070', confidence: 0.93 },
      dimensions: { widthIn: null, heightIn: null, depthIn: null, confidence: 0 },
      merv: { value: null, confidence: 0 },
      readableText: 'LENNOX INDUSTRIES INC.\nMODEL NO G61MPV-36B-070\nSERIAL NO 5807Cxxxxx',
      suggestedMode: null,
      overallConfidence: 0.92,
      notes: null,
    };
  }
  return {
    manufacturer: { value: null, confidence: 0 },
    modelNumber: { value: null, confidence: 0 },
    dimensions: { widthIn: 16, heightIn: 25, depthIn: 1, confidence: 0.96 },
    merv: { value: 11, confidence: 0.94 },
    readableText: '16x25x1 MERV 11\nActual size 15 3/4 x 24 3/4 x 3/4',
    suggestedMode: null,
    overallConfidence: 0.93,
    notes: null,
  };
}
