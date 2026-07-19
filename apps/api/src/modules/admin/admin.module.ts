import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CatalogModule } from '../catalog/catalog.module';
import { SeoModule } from '../seo/seo.module';
import { ShippingModule } from '../shipping/shipping.module';
import { AdminController } from './admin.controller';
import { AdminSeoController } from './admin-seo.controller';
import { AdminShipstationController } from './admin-shipstation.controller';
import { AdminTrackingController } from './admin-tracking.controller';
import { AdminAuditController } from './admin-audit.controller';
import { AdminAuditInterceptor } from './admin-audit.interceptor';
import { AdminAuditService } from './admin-audit.service';
import { AdminAuthController } from './admin-auth.controller';
import { AdminBrandsController } from './admin-brands.controller';
import { AdminBrandsService } from './admin-brands.service';
import { AdminCategoriesController } from './admin-categories.controller';
import { AdminCategoriesService } from './admin-categories.service';
import { AdminDashboardController } from './admin-dashboard.controller';
import { AdminDashboardService } from './admin-dashboard.service';
import { DevUploadController } from './dev-upload.controller';
import { AdminInventoryController } from './admin-inventory.controller';
import { AdminInventoryService } from './admin-inventory.service';
import { AdminProductImagesController } from './admin-product-images.controller';
import { AdminProductImagesService } from './admin-product-images.service';
import { AdminProductsController } from './admin-products.controller';
import { AdminProductsService } from './admin-products.service';
import {
  AdminInvitationController,
  AdminRolesController,
  AdminUsersController,
} from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { PermissionsGuard } from './guards/permissions.guard';
import { StepUpGuard } from './guards/step-up.guard';
import { PermissionService } from './permission.service';
import { productImageStorageProvider } from './product-image-storage';
import { StepUpService } from './step-up.service';

/**
 * Administration (tâche 09) : socle et RBAC fin. Tout vit sous le préfixe
 * `/v1/admin`. Le décorateur `@AdminGuarded()` (rôle STAFF/ADMIN + MFA →
 * PermissionsGuard → StepUpGuard → intercepteur d'audit) protège chaque
 * contrôleur; les endpoints d'auth (login) et d'acceptation d'invitation sont
 * publics par nécessité.
 *
 * Importe AuthModule pour réutiliser tout le socle d'authentification
 * (AuthService, TokenService, OneTimeTokenService, CookieService) — le login
 * admin, le step-up et la révocation de sessions ne réimplémentent rien.
 * Importe ShippingModule pour la vue de resynchronisation ShipStation
 * (tâche 13) : les gardes et l'audit restent ici, la logique reste là-bas.
 */
@Module({
  imports: [AuthModule, ShippingModule, CatalogModule, SeoModule],
  controllers: [
    AdminController,
    AdminAuthController,
    AdminUsersController,
    AdminRolesController,
    AdminInvitationController,
    AdminAuditController,
    AdminDashboardController,
    AdminSeoController,
    AdminShipstationController,
    AdminTrackingController,
    AdminProductsController,
    AdminProductImagesController,
    AdminCategoriesController,
    AdminBrandsController,
    AdminInventoryController,
    DevUploadController,
  ],
  providers: [
    PermissionService,
    StepUpService,
    PermissionsGuard,
    StepUpGuard,
    AdminAuditInterceptor,
    AdminUsersService,
    AdminAuditService,
    AdminDashboardService,
    AdminProductsService,
    AdminProductImagesService,
    AdminCategoriesService,
    AdminBrandsService,
    AdminInventoryService,
    productImageStorageProvider,
  ],
})
export class AdminModule {}
