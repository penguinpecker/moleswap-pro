"use client";
import { useState, useEffect, useRef } from "react";
import { BackgroundImage, NavBar } from "../shared";
import { ExchangePage } from "./ExchangePage";
import { SwapPage } from "./SwapPage";
import { TransactionInfoPage } from "./TransactionInfoPage";
import { SwapSuccessPage } from "./SwapSuccessPage";
import { LottieRefCurrentProps } from "lottie-react";
import { ConnectWalletButton } from "@/components/ConnectWalletButton";
import Image from "next/image";

export type DappStep = "exchange" | "swap" | "transaction-info" | "success";

export default function DappPage() {
  const [currentStep, setCurrentStep] = useState<DappStep>("exchange");
  const [swapData, setSwapData] = useState<any>({
    fromToken: "",
    toToken: "",
    amount: "",
    expectedOut: "",
    transactionId: "",
  });
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(0);

  // Background animation during swap — NO auto-navigation
  // Navigation is controlled solely by SwapPage via onNext callbacks
  useEffect(() => {
    let interval: NodeJS.Timeout;

    if (isLoading) {
      setProgress(0);
      const intervalTime = 50;
      // Progress bar fills slowly — purely visual, never navigates
      interval = setInterval(() => {
        setProgress((prev) => {
          // Cap at 95% — SwapPage controls completion
          if (prev >= 95) {
            return 95;
          }
          return prev + 0.3; // Slow crawl
        });
      }, intervalTime);
    } else {
      setProgress(0);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isLoading]);

  const handleStepChange = (step: DappStep, data?: any) => {
    if (data) {
      setSwapData((prev: any) => ({ ...prev, ...data }));
    }

    // Don't auto-start animation when navigating to swap step
    // Animation will start when user approves swap in wallet
    if (step === "success") {
      setIsLoading(false);
      setProgress(0);
    }

    setCurrentStep(step);
  };

  const renderCurrentStep = () => {
    switch (currentStep) {
      case "exchange":
        return <ExchangePage onNext={handleStepChange} />;
      case "swap":
        return (
          <SwapPage
            onNext={handleStepChange}
            onBack={() => setCurrentStep("exchange")}
            swapData={swapData}
            onSwapStart={() => setIsLoading(true)}
            onSwapComplete={() => setIsLoading(false)}
          />
        );
      case "transaction-info":
        return (
          <TransactionInfoPage
            onNext={handleStepChange}
            onBack={() => setCurrentStep("swap")}
            swapData={swapData}
          />
        );
      case "success":
        return (
          <SwapSuccessPage onNext={handleStepChange} swapData={swapData} />
        );
      default:
        return <ExchangePage onNext={handleStepChange} />;
    }
  };

  const lottieRef = useRef<LottieRefCurrentProps>(null);
  useEffect(() => {
    if (isLoading && lottieRef.current) {
      // Start the animation - it will loop automatically based on loop prop in BackgroundImage
      lottieRef.current.setSpeed(1); // Normal speed
      lottieRef.current.goToAndPlay(0, true); // Start from beginning, loop is handled by the loop prop
    } else if (!isLoading && lottieRef.current) {
      // Stop the animation when swap completes
      lottieRef.current.stop(); // Stop animation
    }
  }, [isLoading]);
  // console.log("progress", progress);
  return (
    <div className="relative flex min-h-screen w-full flex-col items-center gap-2 sm:gap-4">
      <BackgroundImage isLoading={isLoading} ref={lottieRef} />

      <div className="relative z-50 mx-auto mt-2 flex w-full flex-col-reverse gap-2 px-2 sm:mt-4 sm:flex-row sm:items-center sm:gap-4 sm:px-4">
        <div className="flex-1">
          <NavBar />
        </div>
        <div className="bg-peach-500 font-family-ThaleahFat shrink-0 rounded-lg border-3 border-[#523525] px-3 py-2 text-base font-medium tracking-wider text-black shadow-[0px_-6px_0px_0px_#C97E00_inset,0px_7.5px_0px_0px_rgba(255,212,122,0.6)_inset] sm:py-3 sm:text-2xl">
          <ConnectWalletButton />
        </div>
      </div>
      {/* BANNER IMAGE */}
      <Image
        src="/dapp/banner.svg"
        alt="Profile"
        width={100}
        height={20}
        className="z-10 mt-2 mb-[-30px] h-auto w-auto max-w-[90%] sm:mt-8 sm:mb-[-50px] sm:max-w-none"
      />

      <div className="relative z-20 mb-[10%] flex w-full flex-1 items-center justify-center px-1 sm:mb-[8%] sm:px-0">
        {renderCurrentStep()}
      </div>
    </div>
  );
}
