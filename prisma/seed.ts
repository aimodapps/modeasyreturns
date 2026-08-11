import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function resolveShopDomain(): Promise<string> {
  if (process.env.SEED_SHOP_DOMAIN) return process.env.SEED_SHOP_DOMAIN;

  const session = await prisma.session.findFirst({ orderBy: { id: "asc" } });
  if (session) return session.shop;

  throw new Error(
    "No installed shop found to seed against. Install the app on your dev store first " +
      "(run `npm run dev`), or pass SEED_SHOP_DOMAIN=your-shop.myshopify.com explicitly.",
  );
}

const CONDITIONS = [
  {
    code: "unopened_slightly_used",
    label: "Unopened/Slightly used (Just tried a few sprays)",
    action: "PROCEED" as const,
    denyMessage: null,
    denyLinkUrl: null,
    sortOrder: 0,
  },
  {
    code: "used_more_than_1ml",
    label: "Used more than 1ml",
    action: "DENY" as const,
    denyMessage:
      "Sorry! we're not able to accept returns of used perfumes more than 1ml.",
    denyLinkUrl: null,
    sortOrder: 1,
  },
];

const REASONS = [
  {
    code: "defective_product",
    label: "Defective product",
    message:
      "We take best quality assurance measures to ensure that our products are not defective, such as a broken or leaking bottle, malfunctioning spray mechanism, or any other quality issues, however we will still help you process your exchange.",
    sortOrder: 0,
  },
  {
    code: "unsatisfactory_longevity",
    label: "Unsatisfactory longevity or performance",
    message:
      "Mod Fragrances produces only Extrait De Parfum with a high concentration of fragrance oils. For best results, apply from 1–2 inches away so it absorbs well into the skin and improves longevity. Focus on pulse points like behind the ears, chest, and wrists rather than only on clothes. Avoid rubbing the fragrance, as it can alter the scent and reduce performance.",
    sortOrder: 1,
  },
  {
    code: "doesnt_like_fragrance",
    label: "Doesn't Like a Fragrance",
    message:
      "At Mod Fragrances, we want you to be completely satisfied with your fragrance purchase. If, for any reason, you find that the fragrance you ordered doesn't align with your preferences, we offer a return policy. To initiate an exchange based on the reason of 'Doesn't like the fragrance,' please ensure that the product is in its original packaging and no more than 1ml of the fragrance has been used. This allows us to accept the return and process your refund or exchange swiftly. Our aim is to ensure your experience with Mod Fragrances is nothing short of delightful, even in the instance where a scent may not resonate with you. Photo displaying the perfume bottle is not used more than 1ml required when claiming the exchange.",
    sortOrder: 2,
  },
  {
    code: "doesnt_smell_like_original",
    label: "Doesn't smell like original",
    message:
      "Just to clarify, inspired perfumes, often referred to as perfume dupes are crafted to resemble the scent profile of designer fragrances but are not exact replicas. This is because they are made using different formulations and ingredients. While they share similarities with the originals, they maintain their own unique identity. Interestingly, some people even prefer dupes over the designer versions. And the best part? They're significantly more affordable than their high-end counterparts.\n\nIf you still wish to proceed with a return, please ensure that the perfume has not been used more than 1ml, and provide proof by sharing a photo of bottle. We truly appreciate your business!",
    sortOrder: 3,
  },
  {
    code: "broken_during_transit",
    label: "Broken During Transit",
    message:
      "At Mod Fragrances, we ensure each fragrance is carefully packed and shipped with the utmost attention to quality and safety. However, we understand that unforeseen events during transit can occasionally lead to breakage. If you receive a fragrance that has been damaged in transit, please reach out to our customer service team within 24 hours of delivery.",
    sortOrder: 4,
  },
];

async function main() {
  const shopDomain = await resolveShopDomain();
  console.log(`Seeding conditions and reasons for ${shopDomain}...`);

  for (const condition of CONDITIONS) {
    await prisma.conditionOption.upsert({
      where: { shopDomain_code: { shopDomain, code: condition.code } },
      update: condition,
      create: { ...condition, shopDomain },
    });
  }

  for (const reason of REASONS) {
    await prisma.returnReason.upsert({
      where: { shopDomain_code: { shopDomain, code: reason.code } },
      update: reason,
      create: { ...reason, shopDomain },
    });
  }

  console.log(`Seeded ${CONDITIONS.length} conditions and ${REASONS.length} reasons.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
