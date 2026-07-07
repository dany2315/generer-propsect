import { prisma } from "../../../lib/prisma";
import { ProspectStatus } from "@prisma/client";
import { activityLabel } from "../../../lib/display";

const fields = [
  "company_name",
  "siren",
  "siret_siege",
  "company_website",
  "company_linkedin",
  "address",
  "postal_code",
  "city",
  "department",
  "country",
  "activity_code",
  "activity_label",
  "legal_form",
  "creation_date",
  "open_establishments",
  "leaders",
  "known_email",
  "known_phone",
  "priority_score",
  "long_term_lessor_score",
  "sci_type",
  "notes",
  "source_sci_url",
];

function csvEscape(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const limit = Math.min(Math.max(Number(requestUrl.searchParams.get("limit") ?? 500), 1), 10_000);
  const q = requestUrl.searchParams.get("q")?.trim() ?? "";
  const status = requestUrl.searchParams.get("status") as ProspectStatus | null;
  const minScore = requestUrl.searchParams.get("minScore");
  const activity = requestUrl.searchParams.get("activity")?.trim();
  const department = requestUrl.searchParams.get("department")?.trim();
  const maxAge = requestUrl.searchParams.get("maxAge");
  const maxAgeCreationDate =
    maxAge && Number.isFinite(Number(maxAge))
      ? new Date(new Date().getFullYear() - Number(maxAge), 0, 1)
      : undefined;

  const where = {
    ...(status && Object.values(ProspectStatus).includes(status) ? { status } : {}),
    ...(minScore && Number.isFinite(Number(minScore)) ? { score: { gte: Number(minScore) } } : {}),
    ...(activity ? { activity } : {}),
    ...(department ? { department } : {}),
    ...(maxAgeCreationDate ? { creationDate: { gte: maxAgeCreationDate } } : {}),
    ...(q
      ? {
          OR: [
            { siren: { contains: q } },
            { name: { contains: q, mode: "insensitive" as const } },
            { city: { contains: q, mode: "insensitive" as const } },
            { leadersText: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const prospects = await prisma.prospect.findMany({
    where,
    include: {
      contactPoints: true,
      signals: {
        where: {
          key: { in: ["long_term_lessor_score", "structure_type"] },
        },
      },
    },
    orderBy: [{ score: "desc" }, { lastSeenAt: "desc" }],
    take: limit,
  });

  const rows = [
    fields.join(","),
    ...prospects.map((prospect) => {
      const website = prospect.contactPoints.find((contact) => contact.type === "WEBSITE")?.value;
      const linkedin = prospect.contactPoints.find((contact) => contact.type === "LINKEDIN")?.value;
      const email = prospect.contactPoints.find((contact) => contact.type === "EMAIL")?.value;
      const phone = prospect.contactPoints.find((contact) => contact.type === "PHONE")?.value;
      const lessorScore = prospect.signals.find((signal) => signal.key === "long_term_lessor_score")?.value;
      const sciType = prospect.signals.find((signal) => signal.key === "structure_type")?.value;
      const row = {
        company_name: prospect.name,
        siren: prospect.siren,
        siret_siege: prospect.siretSiege,
        company_website: website,
        company_linkedin: linkedin,
        address: prospect.address,
        postal_code: prospect.postalCode,
        city: prospect.city,
        department: prospect.department,
        country: "France",
        activity_code: prospect.activity,
        activity_label: activityLabel(prospect.activity),
        legal_form: "SCI",
        creation_date: prospect.creationDate?.toISOString().slice(0, 10),
        open_establishments: prospect.openEstablishments,
        leaders: prospect.leadersText,
        known_email: email,
        known_phone: phone,
        priority_score: prospect.score,
        long_term_lessor_score: lessorScore,
        sci_type: sciType,
        notes: prospect.notes,
        source_sci_url: `https://annuaire-entreprises.data.gouv.fr/entreprise/${prospect.siren}`,
      };
      return fields.map((field) => csvEscape(row[field as keyof typeof row])).join(",");
    }),
  ];

  return new Response(rows.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="prospects-sci.csv"',
    },
  });
}
