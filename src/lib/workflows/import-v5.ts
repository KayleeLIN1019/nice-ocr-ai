import { prisma } from "@/lib/db/client";
import type { DbClient } from "@/lib/db/types";
import { normalizeMonth, validateRow } from "@/lib/validation/rules";

export type LegacyRecognitionRow = {
  id?: string;
  rowId?: string;
  image_name?: string;
  imageName?: string;
  image?: string;
  image_tag?: string;
  raw_date?: string;
  date?: string;
  normalized_month?: string;
  code?: string;
  name?: string;
  unit?: string;
  qty?: number;
  price?: number;
  amount?: number;
  remark?: string;
  status?: string;
};

export async function importLegacyRecognitionRows(
  rows: LegacyRecognitionRow[],
  db: DbClient = prisma,
) {
  const batch = await db.batch.create({
    data: {
      name: "v5 历史导入批次",
      notes: "由旧版 recognition-results.json 导入",
      status: "imported",
      strategy: "manual",
    },
  });

  const documentMap = new Map<string, string>();
  let importedRows = 0;

  for (const [index, row] of rows.entries()) {
    const imageName = String(row.image_name ?? row.imageName ?? row.image ?? `unknown_${index + 1}`).trim();
    let documentId = documentMap.get(imageName);

    if (!documentId) {
      const document = await db.document.create({
        data: {
          batchId: batch.id,
          originalName: imageName,
          storedPath: "",
          hash: `legacy:${batch.id}:${imageName}`,
          mimeType: "image/jpeg",
          sizeBytes: 0,
          status: "extracted",
          reviewStatus: "pending",
          tag: row.image_tag ?? "",
        },
      });
      documentId = document.id;
      documentMap.set(imageName, documentId);
    }

    const validation = validateRow({
      code: row.code ?? "",
      name: row.name ?? "",
      qty: Number(row.qty) || 0,
      price: Number(row.price) || 0,
      amount: Number(row.amount) || 0,
    });

    await db.recognitionRow.create({
      data: {
        batchId: batch.id,
        documentId,
        rowIndex: importedRows + 1,
        rawDate: row.raw_date ?? row.date ?? "",
        normalizedMonth: row.normalized_month ?? normalizeMonth(row.raw_date ?? row.date ?? ""),
        code: validation.cleanCode,
        name: row.name ?? "",
        unit: row.unit ?? "",
        qty: Number(row.qty) || 0,
        price: Number(row.price) || 0,
        amount: Number(row.amount) || 0,
        remark: row.remark ?? "",
        status: row.status === "已确认" ? "confirmed" : "pending",
        riskLevel: validation.riskLevel,
        riskReasonsJson: JSON.stringify(validation.reasons),
        conflictState: validation.reasons.length ? "open" : "none",
      },
    });
    importedRows += 1;
  }

  return {
    batch,
    documents: documentMap.size,
    rows: importedRows,
  };
}
