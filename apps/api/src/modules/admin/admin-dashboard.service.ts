import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database';
import { type DashboardSummaryDto } from './dto/admin.dto';

/**
 * Données des tuiles du tableau de bord d'accueil (tâche 09) — chiffres réels
 * calculés du jour. Les tuiles vides des tâches suivantes (10, 13, 18, 22) s'y
 * brancheront.
 */
@Injectable()
export class AdminDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(): Promise<DashboardSummaryDto> {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [sales, ordersToShip, pendingReviews, aiReviewQueue, lowStock] = await Promise.all([
      this.prisma.order.aggregate({
        _sum: { totalCents: true },
        _count: true,
        where: { paidAt: { gte: startOfToday } },
      }),
      this.prisma.order.count({ where: { status: { in: ['PAID', 'PROCESSING'] } } }),
      this.prisma.review.count({ where: { status: 'PENDING' } }),
      this.prisma.aiIdentification.count({ where: { status: 'NEEDS_REVIEW' } }),
      this.lowStockCount(),
    ]);

    return {
      salesTodayCents: sales._sum.totalCents ?? 0,
      ordersTodayCount: sales._count,
      ordersToShip,
      pendingReviews,
      aiReviewQueue,
      lowStock,
      currency: 'CAD',
    };
  }

  /** Comparaison de deux colonnes → requête brute (Prisma ne l'exprime pas). */
  private async lowStockCount(): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count
      FROM inventory_levels
      WHERE low_stock_threshold IS NOT NULL
        AND quantity_on_hand <= low_stock_threshold`;
    return Number(rows[0]?.count ?? 0);
  }
}
