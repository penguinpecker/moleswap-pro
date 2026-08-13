"use client";

import { useState, useRef, KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { BackgroundImage, NavBar, MoleMascot } from "../shared";
import { FaXTwitter } from "react-icons/fa6";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { waitlistAPI } from "@/lib/api/client";
import { storeInviteCode } from "@/lib/utils/referral";

export default function WaitlistPage() {
  const router = useRouter();
  const [code, setCode] = useState<string[]>(Array(8).fill(""));
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleInputChange = (index: number, value: string) => {
    // Only allow single digit
    if (value.length > 1) return;

    const newCode = [...code];
    newCode[index] = value;
    setCode(newCode);

    // Auto-focus next input
    if (value && index < 7) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !code[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData("text").slice(0, 8);
    const newCode = [...code];
    pastedData.split("").forEach((char, i) => {
      if (i < 8 && /^\d$/.test(char)) {
        newCode[i] = char;
      }
    });
    setCode(newCode);
    // Focus the next empty input or the last one
    const nextEmptyIndex = newCode.findIndex((val) => !val);
    const focusIndex = nextEmptyIndex === -1 ? 7 : nextEmptyIndex;
    inputRefs.current[focusIndex]?.focus();
  };

  const handleSubmit = async () => {
    const fullCode = code.join("");
    if (fullCode.length !== 8) {
      setError("Please enter a complete 8-digit code");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await waitlistAPI.verifyInviteCode(fullCode);

      if (response.error) {
        setError(response.error);
      } else if (response.data?.valid) {
        // Store invite code for use after Twitter OAuth
        storeInviteCode(fullCode);
        setSuccess(true);

        // Redirect to connect Twitter after brief delay
        setTimeout(() => {
          router.push("/connect-twitter");
        }, 1500);
      }
    } catch (err) {
      setError("Failed to verify code. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <BackgroundImage />
      <NavBar />

      <main>
        {/* Hero */}
        <header className="hero">
          <h1>Enter waitlist code.</h1>
          <MoleMascot />
        </header>

        <section className="onb-col">
          <div className="p-card">
            {/* Code Input Fields */}
            <div className="digits">
              {code.map((digit, index) => (
                <input
                  key={index}
                  ref={(el) => {
                    inputRefs.current[index] = el;
                  }}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={1}
                  value={digit}
                  onChange={(e) => handleInputChange(index, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(index, e)}
                  onPaste={handlePaste}
                  aria-label={`Digit ${index + 1}`}
                />
              ))}
            </div>

            {/* Submit Button */}
            <button
              onClick={handleSubmit}
              disabled={code.join("").length !== 8 || loading || success}
              className="p-btn onb-cta"
            >
              <FaXTwitter size={15} />
              <span>
                {loading ? "VERIFYING..." : success ? "VERIFIED!" : "SUBMIT CODE"}
              </span>
            </button>

            {/* Error Message */}
            {error && <div className="statline err">{error}</div>}

            {/* Success Message */}
            {success && (
              <div className="statline ok">
                Code verified! Redirecting to Twitter login...
              </div>
            )}

            {/* Instructional Text */}
            <p className="onb-helper">
              Find waitlist code on Twitter or from your Community!
            </p>
          </div>
        </section>
      </main>

      {/* Side navigation arrows */}
      <button
        onClick={() => router.push("/connect-twitter")}
        className="side-nav left"
        aria-label="Previous"
        title="Connect Twitter"
      >
        <ChevronLeft size={20} />
      </button>
      <button
        onClick={() => router.push("/earn-xp")}
        className="side-nav right"
        aria-label="Next"
        title="Earn XP"
      >
        <ChevronRight size={20} />
      </button>

      <style jsx global>{`
        .onb-col { max-width: 560px; margin: 0 auto; display: grid; gap: 14px; }
        .digits { margin-top: 4px; }
        .onb-cta { display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
        .onb-helper {
          margin: 18px 0 0; text-align: center; font-size: 11px; font-weight: 800;
          letter-spacing: .09em; text-transform: uppercase; color: var(--ink-3);
        }
        .p-btn:disabled { opacity: .6; cursor: not-allowed; }
        .side-nav {
          position: fixed; z-index: 50; top: 50%; width: 46px; height: 46px; margin-top: -23px;
          border-radius: 50%; display: grid; place-items: center; cursor: pointer; padding: 0; font: inherit;
          background: linear-gradient(180deg, var(--cream), var(--cream-2)); color: var(--ink-2);
          border: 1px solid rgba(255,255,255,.6); box-shadow: var(--sh-1), var(--sh-in);
          transition: transform 150ms ease, color 150ms ease;
        }
        .side-nav:hover { transform: scale(1.1); color: var(--clay); }
        .side-nav.left { left: 14px; }
        .side-nav.right { right: 14px; }
        @media (max-width: 760px) {
          .side-nav { top: auto; margin-top: 0; bottom: 16px; }
        }
      `}</style>
    </>
  );
}
