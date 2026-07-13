import { type AiAnalysisMode } from '@ffc/core';

/**
 * Prompts par mode d'analyse (tâche 17). Un prompt PAR MODE : la consigne
 * oriente la lecture (plaque signalétique vs cadre de filtre) et demande de
 * signaler `suggestedMode` quand la photo appartient manifestement à
 * l'autre mode. La FORME de la réponse est garantie par la sortie
 * structurée (schéma JSON), pas par le prompt.
 */

const COMMON_RULES = `Règles :
- Transcris uniquement ce qui est réellement lisible ; n'invente jamais une valeur. Champ illisible ou absent → value null et confidence basse.
- Les confidences sont des nombres entre 0 et 1 (1 = certitude).
- « overallConfidence » reflète la fiabilité d'ensemble de l'extraction pour l'objectif du mode.
- « readableText » contient la transcription brute du texte visible (quelques lignes, telles quelles).
- Les dimensions sont en pouces. Un marquage « 16x25x1 » signifie largeur 16, hauteur 25, profondeur 1.
- Si la photo correspond manifestement à l'autre type d'analyse, remplis « suggestedMode » avec ce mode ; sinon null.`;

const EQUIPMENT_LABEL_PROMPT = `Tu analyses la photo de la PLAQUE SIGNALÉTIQUE d'un équipement de chauffage/ventilation résidentiel (fournaise, échangeur d'air, thermopompe) pour identifier le filtre à air compatible.

Objectif : extraire le FABRICANT (ex. Lennox, Carrier, Goodman, Trane) et le NUMÉRO DE MODÈLE (« Model No. », « Modèle », « M/N ») exactement tel qu'imprimé, tirets et espaces compris. Attention : ne confonds pas le numéro de SÉRIE (« Serial No. », « S/N ») avec le numéro de modèle. Si des dimensions de filtre sont aussi visibles, extrais-les.

Si la photo montre plutôt un FILTRE à air (cadre en carton avec taille imprimée), indique « suggestedMode »: « FILTER_FRAME ».

${COMMON_RULES}`;

const FILTER_FRAME_PROMPT = `Tu analyses la photo du CADRE d'un filtre à air de fournaise pour retrouver sa taille exacte au catalogue.

Objectif : extraire les DIMENSIONS NOMINALES imprimées sur le cadre (ex. « 16x25x1 », « 20 x 25 x 4 ») en pouces — largeur, hauteur, profondeur — et la COTE MERV si elle est imprimée (« MERV 11 », « MPR »… ne convertis pas un MPR en MERV : si seule une cote MPR est visible, laisse merv.value null et mentionne le MPR dans notes). Beaucoup de cadres affichent aussi la taille réelle (« Actual size 15 3/4 x 24 3/4 x 3/4 ») : privilégie la taille NOMINALE ; à défaut, donne la taille réelle et signale-le dans notes. Si un fabricant ou un numéro de modèle du FILTRE est imprimé, extrais-les aussi.

Si la photo montre plutôt la PLAQUE SIGNALÉTIQUE d'un équipement (étiquette métallique avec Model No. / Serial No.), indique « suggestedMode »: « EQUIPMENT_LABEL ».

${COMMON_RULES}`;

export function visionPromptFor(mode: AiAnalysisMode): string {
  return mode === 'EQUIPMENT_LABEL' ? EQUIPMENT_LABEL_PROMPT : FILTER_FRAME_PROMPT;
}
