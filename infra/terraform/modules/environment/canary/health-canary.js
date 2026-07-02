const synthetics = require('Synthetics');
const log = require('SyntheticsLogger');

// Sonde de disponibilité : interroge /v1/health et échoue si le statut n'est
// pas 2xx. L'URL est fournie par la variable d'environnement HEALTH_URL.
// Ce fichier est empaqueté par Terraform (archive_file) au chemin exigé par
// AWS Synthetics : nodejs/node_modules/health-canary.js.
const healthCheck = async function () {
  const url = process.env.HEALTH_URL;
  const page = await synthetics.getPage();
  const response = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  const status = response ? response.status() : 0;
  if (status < 200 || status > 299) {
    throw new Error(`Health check en échec : statut ${status} pour ${url}`);
  }
  log.info(`Health OK : ${status}`);
};

exports.handler = async function () {
  return await healthCheck();
};
