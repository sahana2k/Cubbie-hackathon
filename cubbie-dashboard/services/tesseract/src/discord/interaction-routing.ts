/** Gateway and webhook interaction delivery are mutually exclusive in Discord. */
export function checkInteractionRouting(application: { interactionsEndpointURL: string | null }) {
  if (application.interactionsEndpointURL) {
    throw new Error('Slash commands are routed to an external Interactions Endpoint URL. Clear that URL in this Discord application’s General Information settings, save, then reconnect Tesseract. This bot receives commands through its Discord connection.');
  }
}
