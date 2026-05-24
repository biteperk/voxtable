import { NextFunction, Request, Response } from "express";
import admin from "firebase-admin";

import { env } from "../config/env";
import { AppError } from "../domain/errors";

let initialized = false;

function ensureInitialized(): admin.app.App {
  if (initialized) {
    return admin.app();
  }

  if (!env.FIREBASE_PROJECT_ID) {
    throw new AppError(
      500,
      "FIREBASE_NOT_CONFIGURED",
      "FIREBASE_PROJECT_ID is required to verify ID tokens."
    );
  }

  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: env.FIREBASE_PROJECT_ID
  });
  initialized = true;
  return admin.app();
}

export interface AuthenticatedRequest extends Request {
  firebaseUser?: admin.auth.DecodedIdToken;
}

export async function requireFirebaseAuth(
  request: AuthenticatedRequest,
  _response: Response,
  next: NextFunction
): Promise<void> {
  const header = request.header("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return next(
      new AppError(401, "MISSING_BEARER_TOKEN", "Authorization: Bearer <token> required.")
    );
  }

  try {
    const app = ensureInitialized();
    const decoded = await app.auth().verifyIdToken(match[1]!);
    request.firebaseUser = decoded;
    next();
  } catch (error) {
    next(new AppError(401, "INVALID_TOKEN", "ID token verification failed."));
  }
}
