import { NextResponse } from "next/server";
import {
  getRecognitionSettings,
  updateRecognitionDefaults,
  upsertAiProviderConfig,
} from "@/lib/recognition/settings";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await getRecognitionSettings());
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    if (body.defaults) {
      await updateRecognitionDefaults(body.defaults);
    }
    if (Array.isArray(body.providers)) {
      for (const provider of body.providers) {
        await upsertAiProviderConfig(provider);
      }
    }
    return NextResponse.json(await getRecognitionSettings());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
