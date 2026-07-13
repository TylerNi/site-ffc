import Anthropic from '@anthropic-ai/sdk';
import { Logger } from '@nestjs/common';
import {
  type VisionAnalysis,
  type VisionInput,
  type VisionProvider,
  VisionProviderError,
} from './vision-provider';
import { visionPromptFor } from './vision-prompts';
import { parseVisionExtraction, VISION_OUTPUT_JSON_SCHEMA } from './vision-schema';

/**
 * Fournisseur de vision Anthropic (Claude) — SDK officiel, sortie
 * structurée NATIVE (`output_config.format`, schéma JSON strict).
 *
 * - Retries transitoires (429/5xx/réseau) : gérés par le SDK (maxRetries) ;
 *   au-delà, l'erreur est marquée `retryable` et BullMQ reprend la main.
 * - AUCUN contenu d'image dans les logs (taille et latence seulement).
 * - Aucune option de rétention/entraînement n'est activée : l'API Anthropic
 *   n'entraîne pas ses modèles sur les données clients (docs/ia.md, Loi 25).
 */
export class AnthropicVisionProvider implements VisionProvider {
  readonly name = 'anthropic';
  private readonly logger = new Logger(AnthropicVisionProvider.name);
  private readonly client: Anthropic | null;

  constructor(
    apiKey: string | undefined,
    readonly model: string,
    client?: Anthropic,
  ) {
    this.client =
      client ?? (apiKey ? new Anthropic({ apiKey, maxRetries: 2, timeout: 90_000 }) : null);
    if (!this.client) {
      this.logger.warn('ANTHROPIC_API_KEY absente — analyse de vision Claude désactivée (503).');
    }
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async analyze(input: VisionInput): Promise<VisionAnalysis> {
    if (!this.client) {
      throw new VisionProviderError('Clé API Anthropic absente.', this.name, false);
    }

    const startedAt = Date.now();
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: 16000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: input.mediaType,
                  data: input.image.toString('base64'),
                },
              },
              { type: 'text', text: visionPromptFor(input.mode) },
            ],
          },
        ],
        output_config: {
          format: {
            type: 'json_schema',
            schema: VISION_OUTPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
          },
        },
      });
    } catch (error) {
      throw this.mapSdkError(error);
    }

    if (response.stop_reason === 'refusal') {
      throw new VisionProviderError(
        'Le fournisseur a refusé d’analyser cette image (politique de sécurité).',
        this.name,
        false,
      );
    }
    if (response.stop_reason === 'max_tokens') {
      throw new VisionProviderError('Réponse tronquée (max_tokens).', this.name, false);
    }

    const text = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === 'text',
    )?.text;
    if (!text) {
      throw new VisionProviderError('Réponse sans contenu textuel.', this.name, false);
    }

    let extraction;
    try {
      extraction = parseVisionExtraction(JSON.parse(text));
    } catch (error) {
      throw new VisionProviderError(
        `Sortie structurée invalide : ${error instanceof Error ? error.message : String(error)}`,
        this.name,
        false,
      );
    }

    const latencyMs = Date.now() - startedAt;
    this.logger.log(
      `Analyse Claude (${this.model}, mode ${input.mode}) : ${latencyMs} ms, ` +
        `${response.usage.input_tokens}+${response.usage.output_tokens} jetons.`,
    );
    return {
      extraction,
      provider: this.name,
      model: response.model,
      latencyMs,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  /** 429/5xx/réseau (après les retries du SDK) → retentable par BullMQ ; le reste est définitif. */
  private mapSdkError(error: unknown): VisionProviderError {
    if (
      error instanceof Anthropic.RateLimitError ||
      error instanceof Anthropic.InternalServerError ||
      error instanceof Anthropic.APIConnectionError
    ) {
      return new VisionProviderError(
        `Erreur transitoire Anthropic : ${error.message}`,
        this.name,
        true,
      );
    }
    if (error instanceof Anthropic.APIError) {
      return new VisionProviderError(
        `Erreur Anthropic ${error.status ?? '?'} : ${error.message}`,
        this.name,
        false,
      );
    }
    return new VisionProviderError(
      error instanceof Error ? error.message : String(error),
      this.name,
      false,
    );
  }
}
