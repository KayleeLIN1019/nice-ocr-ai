import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { badRequest, handleRoute, parseJson } from "@/lib/api/http";
import {
  clearShortProductCodes,
  replaceProductCodesByName,
  replaceProductNamesByCode,
  updateRecognitionRow,
} from "@/lib/workflows/rows";

export const runtime = "nodejs";

const applySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("clear_short_codes"), rowIds: z.array(z.string()).min(1) }),
  z.object({
    type: z.literal("replace_code_by_name"),
    name: z.string().min(1),
    toCode: z.string().min(1),
    rowIds: z.array(z.string()).min(1).optional(),
  }),
  z.object({
    type: z.literal("replace_name_by_code"),
    code: z.string().min(1),
    toName: z.string().min(1),
    rowIds: z.array(z.string()).min(1).optional(),
  }),
  z.object({
    type: z.literal("learned_correction"),
    field: z.enum(["name", "code"]),
    toValue: z.string(),
    rowIds: z.array(z.string()).min(1),
  }),
]);

export async function POST(request: Request) {
  return handleRoute(async () => {
    const body = await parseJson(request, applySchema);
    const result = await prisma.$transaction(async (tx) => {
      if (body.type === "clear_short_codes") {
        return clearShortProductCodes({ rowIds: body.rowIds }, tx);
      }
      if (body.type === "replace_code_by_name") {
        return replaceProductCodesByName(
          { name: body.name, toCode: body.toCode, rowIds: body.rowIds },
          tx,
        );
      }
      if (body.type === "replace_name_by_code") {
        return replaceProductNamesByCode(
          { code: body.code, toName: body.toName, rowIds: body.rowIds },
          tx,
        );
      }
      if (body.type === "learned_correction") {
        let updated = 0;
        for (const rowId of body.rowIds) {
          const row = await updateRecognitionRow(
            rowId,
            body.field === "name" ? { name: body.toValue } : { code: body.toValue },
            tx,
          );
          if (row) updated += 1;
        }
        return { matched: body.rowIds.length, updated };
      }
      throw badRequest("Unsupported suggestion type");
    });

    if (result === null) throw badRequest("No rows matched suggestion");
    return NextResponse.json(result);
  });
}
