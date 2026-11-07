// Official accounts: Disney's brand channels a Mix user could follow
// (docs/MIX_API.md section 4). Not implemented yet (phase 5); the Mix app
// calls /officialAccount/all right after /state at login and shows
// "Oops! Something went wrong" if it fails, so it answers with an empty
// list, which passes OfficialAccountGetter.ValidateResponse.
import express from "express";
import { authenticateMix } from "./auth.ts";
import { buildResponse } from "./common.ts";

const router = express.Router();

router.post('/officialAccount/all', authenticateMix, (req, res) => {
    res.json(buildResponse({ OfficialAccountIds: [] }));
});

export default router;
