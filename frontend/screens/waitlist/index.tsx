"use client";

import { useState, useRef, KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { BackgroundImage, NavBar } from "../shared";
import { ConnectWalletButton } from "@/components/ConnectWalletButton";
import { FaXTwitter } from "react-icons/fa6";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Image from "next/image";
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
    <div className="relative flex min-h-screen w-full flex-col items-center gap-4">
      <BackgroundImage />

      <div className="relative z-20 flex w-full max-w-3xl flex-1 flex-col px-1 sm:p-6 sm:px-2">
        {/* Header */}
        <div className="relative top-[20px] z-10 mx-auto flex w-[95%] items-center justify-center rounded-lg px-2 py-2 text-center sm:top-[40px] sm:w-[85%] sm:px-6 sm:py-4">
          <h1 className="text-peach-300 font-family-ThaleahFat text-shadow-header text-lg font-bold tracking-widest uppercase sm:text-3xl md:text-5xl">
            ENTER WAITLIST CODE
          </h1>

          <Image
            src="/quest/header-quest-bg.png"
            alt="Header BG"
            width={200}
            height={200}
            className="absolute inset-0 left-0 z-[-1] h-full w-full"
          />
        </div>

        {/* Body */}
        <div className="relative mb-6 block h-full">
          <Image
            src="/quest/Quest-BG.png"
            alt="BG"
            width={200}
            height={200}
            className="absolute inset-0 z-0 h-full w-full object-fill"
          />

          {/* Waitlist Form */}
          <div className="relative z-50 mx-auto mt-6 mb-6 grid w-full grid-cols-1 gap-2 p-2 sm:mt-12 sm:w-[85%] sm:gap-4 sm:p-4">
            <div className="grid grid-cols-1 gap-2 sm:gap-4">
              {/* Code Input Fields */}
              <div className="relative z-10 mx-auto w-full rounded-lg px-2 py-2 text-center sm:w-[90%] sm:px-6 sm:py-4">
                <div className="mb-2 flex justify-center gap-1 sm:mb-4 sm:gap-2 md:mb-6 md:gap-3">
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
                      className="font-family-ThaleahFat h-8 w-8 rounded border-2 border-[#140901] bg-white text-center text-sm font-bold text-black focus:border-[#5D2C28] focus:outline-none sm:h-10 sm:w-10 sm:text-lg md:h-12 md:w-12 md:text-xl"
                      style={{
                        imageRendering: "pixelated",
                      }}
                    />
                  ))}
                </div>
                <Image
                  src="/quest/header-quest-bg.png"
                  alt="BG"
                  width={200}
                  height={200}
                  className="absolute inset-0 left-0 z-[-1] h-full w-full"
                />
              </div>

              {/* Submit Button */}
              <button
                onClick={handleSubmit}
                disabled={code.join("").length !== 8 || loading || success}
                className="relative w-full cursor-pointer rounded py-2 text-base font-bold text-white transition-all hover:scale-105 disabled:cursor-not-allowed disabled:opacity-60 sm:py-4 sm:text-xl"
              >
                <div className="font-family-ThaleahFat flex items-center justify-center gap-1 text-base font-thin sm:gap-2 sm:text-xl md:text-2xl">
                  <FaXTwitter className="h-4 w-4 sm:h-5 sm:w-5 md:h-6 md:w-6" />
                  <span>
                    {loading ? "VERIFYING..." : success ? "VERIFIED!" : "SUBMIT CODE"}
                  </span>
                </div>
                <Image
                  src="/dapp/connect-wallet.png"
                  alt="Submit"
                  width={200}
                  height={200}
                  className="absolute inset-0 z-[-1] h-full w-full object-fill"
                />
              </button>

              {/* Error Message */}
              {error && (
                <div className="font-family-ThaleahFat text-center text-sm text-red-400 sm:text-base">
                  {error}
                </div>
              )}

              {/* Success Message */}
              {success && (
                <div className="font-family-ThaleahFat text-center text-sm text-green-400 sm:text-base">
                  Code verified! Redirecting to Twitter login...
                </div>
              )}

              {/* Instructional Text */}
              <div className="relative z-10 mx-auto w-full rounded-lg px-2 text-center sm:w-[90%] sm:px-6">
                <p className="font-family-ThaleahFat text-center text-xs text-[#B0B0B0] uppercase sm:text-2xl">
                  Find waitlist code on Twitter or from your Community!
                </p>
                {/* <Image
                src="/quest/header-quest-bg.png"
                alt="BG"
                width={200}
                height={200}
                className="absolute inset-0 left-0 z-[-1] h-full w-full"
              /> */}
              </div>
            </div>
          </div>

          {/* // NAVIGATION ARROWS  */}
          <button
            onClick={() => router.push("/connect-twitter")}
            className="group absolute bottom-0 left-2 z-50 flex h-6 w-6 cursor-pointer items-center justify-center transition-all hover:scale-110 sm:top-1/2 sm:bottom-auto sm:left-4 sm:h-10 sm:w-10 sm:-translate-y-1/2 md:h-12 md:w-12"
          >
            <Image
              src="/profile/footer-image.svg"
              alt="Previous"
              fill
              className="absolute inset-0 object-contain"
            />
            <ChevronLeft className="text-peach-300 group-hover:text-peach-400 relative z-10 h-3 w-3 transition-colors sm:h-5 sm:w-5 md:h-6 md:w-6" />
          </button>
          <button
            onClick={() => router.push("/earn-xp")}
            className="group absolute right-2 bottom-0 z-50 flex h-6 w-6 cursor-pointer items-center justify-center transition-all hover:scale-110 sm:top-1/2 sm:right-4 sm:bottom-auto sm:h-10 sm:w-10 sm:-translate-y-1/2 md:h-12 md:w-12"
          >
            <Image
              src="/profile/footer-image.svg"
              alt="Next"
              fill
              className="absolute inset-0 object-contain"
            />
            <ChevronRight className="text-peach-300 group-hover:text-peach-400 relative z-10 h-3 w-3 transition-colors sm:h-5 sm:w-5 md:h-6 md:w-6" />
          </button>
        </div>
      </div>
    </div>
  );
}
