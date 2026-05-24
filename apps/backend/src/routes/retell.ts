import { Router } from "express";

import { asyncHandler } from "../http/asyncHandler";
import {
  assertRetellSignature,
  handleRetellFunction,
  handleRetellInbound,
  handleRetellWebhook
} from "../services/retellService";

type RequestWithRawBody = Express.Request & { rawBody?: string };

export const retellRouter = Router();

retellRouter.use(
  "/retell",
  asyncHandler(async (request, _response, next) => {
    await assertRetellSignature(
      request.header("x-retell-signature"),
      (request as RequestWithRawBody).rawBody
    );
    next();
  })
);

retellRouter.post(
  "/retell/webhook",
  asyncHandler(async (request, response) => {
    await handleRetellWebhook(request.body);
    response.status(204).send();
  })
);

retellRouter.post(
  "/retell/inbound",
  asyncHandler(async (request, response) => {
    const result = await handleRetellInbound(request.body);
    response.json(result);
  })
);

retellRouter.post(
  "/retell/functions",
  asyncHandler(async (request, response) => {
    const result = await handleRetellFunction(request.body);
    response.json(result);
  })
);

retellRouter.post(
  "/retell/tools/check-availability",
  asyncHandler(async (request, response) => {
    const result = await handleRetellFunction(request.body, "check_availability");
    response.json(result);
  })
);

retellRouter.post(
  "/retell/tools/create-booking",
  asyncHandler(async (request, response) => {
    const result = await handleRetellFunction(request.body, "create_booking");
    response.json(result);
  })
);
