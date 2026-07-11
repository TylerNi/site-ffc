/**
 * Faux RevalidationClient (tâche 10) : capture les appels au lieu de faire
 * un vrai POST /api/revalidate vers la vitrine web (pas de serveur Next en
 * test) — permet d'asserter les étiquettes demandées à la publication.
 */
export class FakeRevalidationClient {
  readonly calls: string[][] = [];

  async revalidate(tags: string[]): Promise<void> {
    this.calls.push(tags);
  }
}
