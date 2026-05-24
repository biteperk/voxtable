import { Router } from "express";

import { env } from "../config/env";
import { asyncHandler } from "../http/asyncHandler";
import {
  assertTwilioSignature,
  handleTwilioIncomingCall,
  handleTwilioStatusCallback
} from "../services/twilioService";

export const twilioRouter = Router();

twilioRouter.use(
  "/twilio",
  asyncHandler(async (request, _response, next) => {
    assertTwilioSignature(
      request.header("x-twilio-signature"),
      `${env.PUBLIC_API_BASE_URL}${request.originalUrl}`,
      request.body
    );
    next();
  })
);

twilioRouter.post(
  "/twilio/voice",
  asyncHandler(async (request, response) => {
    const twiml = await handleTwilioIncomingCall(request.body);
    response.type("text/xml").send(twiml);
  })
);

twilioRouter.post(
  "/twilio/status",
  asyncHandler(async (request, response) => {
    await handleTwilioStatusCallback(request.body);
    response.status(204).send();
  })
);
