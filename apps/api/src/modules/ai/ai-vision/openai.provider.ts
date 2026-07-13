import { Logger } from '@nestjs/common';
import OpenAI from 'openai';
import {
  type VisionAnalysis,
  type VisionInput,
  type VisionProvider,
  VisionProviderError,
} from './vision-provider';
import { visionPromptFor } from './vision-prompts';
import { parseVisionExtraction, VISION_OUTPUT_JSON_SCHEMA } from './vision-schema';

/**
 * Fournisseur de vision OpenAI (GPT) — SDK officiel, API Responses, sortie
 * structurée native (`text.format` json_schema strict). Mêmes garanties que
 * l'implémentation Anthropic : retries transitoires via le SDK, aucune image
 * dans les logs, aucune option de rétention/entraînement activée (l'API
 * OpenAI n'entraîne pas ses modèles sur les données API par défaut — ne
 * JAMAIS activer le partage de données ; docs/ia.md).
 */
export class OpenAiVisionProvider implements VisionProvider {
  readonly name = 'openai';
  private readonly logger = new Logger(OpenAiVisionProvider.name);
  private readonly client: OpenAI | null;

  constructor(
    apiKey: string | undefined,
    readonly model: string,
    client?: OpenAI,
  ) {
    this.client =
      client ?? (apiKey ? new OpenAI({ apiKey, maxRetries: 2, timeout: 90_000 }) : null);
    if (!this.client) {
      this.logger.warn('OPENAI_API_KEY absente — analyse de vision GPT désactivée (503).');
    }
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async analyze(input: VisionInput): Promise<VisionAnalysis> {
    if (!this.client) {
      throw new VisionProviderError('Clé API OpenAI absente.', this.name, false);
    }

    const startedAt = Date.now();
    let response: OpenAI.Responses.Response;
    try {
      response = await this.client.responses.create({
        model: this.model,
        max_output_tokens: 16000,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_image',
                image_url: `data:${input.mediaType};base64,${input.image.toString('base64')}`,
                detail: 'auto',
              },
              { type: 'input_text', text: visionPromptFor(input.mode) },
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'vision_extraction',
            schema: VISION_OUTPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
            strict: true,
          },
        },
      });
    } catch (error) {
      throw this.mapSdkError(error);
    }

    if (response.status === 'incomplete') {
      throw new VisionProviderError(
        `Réponse incomplète (${response.incomplete_details?.reason ?? 'raison inconnue'}).`,
        this.name,
        false,
      );
    }
    const refusal = response.output
      .flatMap((item) => (item.type === 'message' ? item.content : []))
      .find((content) => content.type === 'refusal');
    if (refusal) {
      throw new VisionProviderError(
        'Le fournisseur a refusé d’analyser cette image (politique de sécurité).',
        this.name,
        false,
      );
    }

    const text = response.output_text;
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
    const usage = response.usage
      ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
      : null;
    this.logger.log(
      `Analyse GPT (${this.model}, mode ${input.mode}) : ${latencyMs} ms, ` +
        `${usage ? `${usage.inputTokens}+${usage.outputTokens}` : '?'} jetons.`,
    );
    return { extraction, provider: this.name, model: response.model, latencyMs, usage };
  }

  /** 429/5xx/réseau (après les retries du SDK) → retentable par BullMQ ; le reste est définitif. */
  private mapSdkError(error: unknown): VisionProviderError {
    if (
      error instanceof OpenAI.RateLimitError ||
      error instanceof OpenAI.InternalServerError ||
      error instanceof OpenAI.APIConnectionError
    ) {
      return new VisionProviderError(
        `Erreur transitoire OpenAI : ${error.message}`,
        this.name,
        true,
      );
    }
    if (error instanceof OpenAI.APIError) {
      return new VisionProviderError(
        `Erreur OpenAI ${error.status ?? '?'} : ${error.message}`,
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
