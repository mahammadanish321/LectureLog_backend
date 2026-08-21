import express from "express";
import { 
  checkEmail, 
  adminLogin, 
  login, 
  signup, 
  studentLogin, 
  claimInit, 
  claimVerify, 
  claimFinalize, 
  adminSignupInit, 
  adminSignupVerify, 
  forgotPasswordInit, 
  forgotPasswordVerify, 
  forgotPasswordFinalize,
  firebaseLogin,
  firebaseClaim
} from "../controllers/auth.controller.js";

const router = express.Router();

// NEW ENDPOINT: Check email availability across all orgs
router.get("/check-email", checkEmail);

router.post("/login", login);
router.post("/admin/login", adminLogin);
router.post("/student/login", studentLogin);

// Firebase Google Authentication & Activation
router.post("/firebase-login", firebaseLogin);
router.post("/firebase-claim", firebaseClaim);

// Admin Dedicated Signup
router.post("/admin-signup-init", adminSignupInit);
router.post("/admin-signup-verify", adminSignupVerify);

// Claim/Activation Flow
router.post("/claim-init", claimInit);
router.post("/claim-verify", claimVerify);
router.post("/claim-finalize", claimFinalize);

// Forgot Password Flow
router.post("/forgot-password-init", forgotPasswordInit);
router.post("/forgot-password-verify", forgotPasswordVerify);
router.post("/forgot-password-finalize", forgotPasswordFinalize);

export default router;

