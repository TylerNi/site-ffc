/**
 * Génère docs/database-erd.md — diagrammes entité-relation Mermaid par
 * domaine, à partir du DMMF du client Prisma généré (aucune dépendance
 * externe, pas de navigateur).
 *
 * Régénération : pnpm --filter @ffc/api db:erd
 * (à relancer après chaque évolution du schéma ; vérifié en revue de PR).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';

type DmmfModel = (typeof Prisma.dmmf.datamodel.models)[number];
type DmmfField = DmmfModel['fields'][number];

/** Domaines fonctionnels — chaque diagramme reste lisible. */
const DOMAINS: Array<{ title: string; models: string[] }> = [
  {
    title: 'Comptes et accès',
    models: [
      'User',
      'Address',
      'UserDevice',
      'RefreshToken',
      'Role',
      'Permission',
      'RolePermission',
      'UserRoleAssignment',
    ],
  },
  {
    title: 'Catalogue',
    models: [
      'Brand',
      'Category',
      'CategoryTranslation',
      'Product',
      'ProductTranslation',
      'ProductVariant',
      'ProductImage',
      'InventoryLevel',
      'InventoryMovement',
    ],
  },
  {
    title: 'Compatibilité équipements et IA',
    models: ['EquipmentModel', 'ModelFilterCompatibility', 'UserEquipment', 'AiIdentification'],
  },
  {
    title: 'Fournisseurs',
    models: ['Supplier', 'SupplierProduct'],
  },
  {
    title: 'Ventes',
    models: [
      'Cart',
      'CartItem',
      'Order',
      'OrderItem',
      'OrderStatusHistory',
      'Payment',
      'Refund',
      'Invoice',
      'InvoiceCounter',
      'Coupon',
      'CouponRedemption',
    ],
  },
  {
    title: 'Expédition',
    models: ['Shipment', 'ShipmentEvent'],
  },
  {
    title: 'Rappels, notifications et avis',
    models: ['ReplenishmentPlan', 'NotificationPreference', 'Notification', 'Review'],
  },
  {
    title: 'Technique',
    models: ['WebhookEvent', 'AuditLog', 'Setting'],
  },
];

function tableName(model: DmmfModel): string {
  return model.dbName ?? model.name;
}

function columnType(field: DmmfField): string {
  const base = field.kind === 'enum' ? `enum_${field.type}` : field.type.toLowerCase();
  return field.isList ? `${base}_array` : base;
}

function columnLine(model: DmmfModel, field: DmmfField): string | null {
  if (field.kind === 'object') return null; // relations rendues comme liens
  const name = field.dbName ?? field.name;
  const keys: string[] = [];
  if (field.isId || (model.primaryKey?.fields ?? []).includes(field.name)) keys.push('PK');
  if (field.isUnique) keys.push('UK');
  if (
    model.fields.some(
      (candidate) =>
        candidate.kind === 'object' && (candidate.relationFromFields ?? []).includes(field.name),
    )
  ) {
    keys.push('FK');
  }
  const suffix = keys.length > 0 ? ` ${keys.join(',')}` : field.isRequired ? '' : ' "nullable"';
  return `    ${columnType(field)} ${name}${suffix}`;
}

interface RelationLink {
  from: string;
  to: string;
  label: string;
  fromOptional: boolean;
}

function collectRelations(models: DmmfModel[]): RelationLink[] {
  const byName = new Map(models.map((model) => [model.name, model]));
  const links: RelationLink[] = [];
  for (const model of models) {
    for (const field of model.fields) {
      // Seul le côté porteur de la FK émet le lien (évite les doublons).
      if (field.kind !== 'object' || (field.relationFromFields ?? []).length === 0) continue;
      if (!byName.has(field.type)) continue;
      links.push({
        from: model.name,
        to: field.type,
        label: field.name,
        fromOptional: !field.isRequired,
      });
    }
  }
  return links;
}

function mermaidForDomain(title: string, modelNames: string[]): string {
  const models = Prisma.dmmf.datamodel.models.filter((model) => modelNames.includes(model.name));
  const byName = new Map(models.map((model) => [model.name, model]));

  const lines: string[] = ['```mermaid', 'erDiagram'];
  for (const model of models) {
    lines.push(`  ${tableName(model)} {`);
    for (const field of model.fields) {
      const column = columnLine(model, field);
      if (column) lines.push(column);
    }
    lines.push('  }');
  }
  for (const link of collectRelations(models)) {
    const from = tableName(byName.get(link.from)!);
    const to = tableName(byName.get(link.to)!);
    // « many » côté porteur de FK ; o| si la FK est nullable.
    const cardinality = link.fromOptional ? '}o--o|' : '}o--||';
    lines.push(`  ${from} ${cardinality} ${to} : "${link.label}"`);
  }
  lines.push('```');
  return `## ${title}\n\n${lines.join('\n')}\n`;
}

function main(): void {
  const covered = new Set(DOMAINS.flatMap((domain) => domain.models));
  const missing = Prisma.dmmf.datamodel.models
    .map((model) => model.name)
    .filter((name) => !covered.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Modèles absents des domaines ERD (à ajouter dans generate-erd.ts) : ${missing.join(', ')}`,
    );
  }

  const header =
    '# Diagrammes entité-relation — base de données FFC\n\n' +
    '> Document GÉNÉRÉ par `pnpm --filter @ffc/api db:erd` — ne pas éditer à la main.\n' +
    '> Un diagramme par domaine fonctionnel ; conventions et décisions dans [database.md](./database.md).\n\n' +
    `Tables : ${Prisma.dmmf.datamodel.models.length} · Enums : ${Prisma.dmmf.datamodel.enums.length}\n\n`;

  const body = DOMAINS.map((domain) => mermaidForDomain(domain.title, domain.models)).join('\n');
  const target = join(__dirname, '..', '..', '..', 'docs', 'database-erd.md');
  writeFileSync(target, header + body, 'utf8');
  console.log(`ERD généré : ${target}`);
}

main();
