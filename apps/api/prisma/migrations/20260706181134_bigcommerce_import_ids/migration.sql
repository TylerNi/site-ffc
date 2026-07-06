-- AlterTable
ALTER TABLE "brands" ADD COLUMN     "bigcommerce_brand_id" TEXT;

-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "bigcommerce_category_id" TEXT;

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "bigcommerce_variant_id" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "bigcommerce_product_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "brands_bigcommerce_brand_id_key" ON "brands"("bigcommerce_brand_id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_bigcommerce_category_id_key" ON "categories"("bigcommerce_category_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_bigcommerce_variant_id_key" ON "product_variants"("bigcommerce_variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_bigcommerce_product_id_key" ON "products"("bigcommerce_product_id");

