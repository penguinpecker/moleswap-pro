"use client";
import { useState, useEffect } from "react";
import { BackgroundImage, NavBar } from "../shared";
import { ExchangePage } from "./ExchangePage";
import { SwapPage } from "./SwapPage";
import { TransactionInfoPage } from "./TransactionInfoPage";
import { SwapSuccessPage } from "./SwapSuccessPage";

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

  return (
    <div className="relative min-h-screen w-full">
      <BackgroundImage isLoading={isLoading} />
      <NavBar />
      {renderCurrentStep()}

      {/* Shared Burrow view styles for the dapp wizard (review / txinfo / success),
          ported from the design prototype. Visual tokens come from burrow.css. */}
      <style jsx global>{`
        .tool-btn {
          width: 34px;
          height: 34px;
          border-radius: 11px;
          cursor: pointer;
          display: grid;
          place-items: center;
          background: var(--p-chip);
          border: 1px solid var(--p-card-line);
          color: var(--p-card-ink-2);
          box-shadow: var(--p-card-sh);
        }
        .tool-btn:active {
          transform: scale(0.94);
        }
        .pick-head {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .pick-head h3 {
          flex: 1;
        }
        .dapp-col {
          margin: 0 auto;
          padding-top: 26px;
        }
        .rv-row {
          display: flex;
          align-items: center;
          gap: 14px;
          padding: 15px 17px;
          border-radius: var(--r-lg);
          background: var(--p-field);
          border: 1px solid var(--p-card-line);
        }
        .rv-row .rv-amt {
          font-family: var(--font-num);
          font-size: 1.5rem;
          font-weight: 700;
          letter-spacing: -0.03em;
        }
        .rv-row .rv-sub {
          font-size: 12px;
          color: var(--p-card-ink-3);
          margin-top: 3px;
        }
        .rv-row .rv-eta {
          margin-left: auto;
          font-family: var(--font-num);
          font-size: 12px;
          color: var(--p-card-ink-3);
          align-self: flex-start;
        }
        .rv-mid {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px 17px;
          font-size: 13px;
          font-weight: 700;
          color: var(--p-card-ink-2);
        }
        .rv-strip {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          padding: 12px 16px;
          margin-top: 12px;
          border-radius: var(--r-md);
          background: rgba(255, 255, 255, 0.55);
          border: 1px solid rgba(44, 26, 12, 0.08);
          font-family: var(--font-num);
          font-size: 12.5px;
          font-weight: 600;
          color: var(--p-card-ink-2);
          flex-wrap: wrap;
        }
        .live-req {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 11.5px;
          font-weight: 700;
          color: #1e6b40;
          margin-top: 8px;
        }
        .warn-red {
          margin-top: 12px;
          padding: 11px 13px;
          border-radius: var(--r-md);
          font-size: 12px;
          background: rgba(184, 55, 31, 0.1);
          border: 1px solid rgba(184, 55, 31, 0.3);
          color: var(--rust);
        }
        /* Pre-flight panel on the review card: same field/strip tokens as .rv-row / .rv-strip. */
        .pf-box {
          margin-top: 12px;
          padding: 12px 16px;
          border-radius: var(--r-md);
          background: rgba(255, 255, 255, 0.55);
          border: 1px solid rgba(44, 26, 12, 0.08);
        }
        .pf-head {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          gap: 10px;
          font-size: 10.5px;
          font-weight: 800;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--p-card-ink-3);
        }
        .pf-head .pf-sub {
          font-weight: 700;
          letter-spacing: 0.02em;
          text-transform: none;
          color: var(--p-card-ink-3);
        }
        .pf-note {
          margin-top: 8px;
          font-size: 12.5px;
          color: var(--p-card-ink-3);
        }
        .pf-raw {
          margin-top: 6px;
          font-size: 11px;
        }
        .pf-raw summary {
          cursor: pointer;
          font-weight: 700;
        }
        .pf-raw code {
          display: block;
          margin-top: 4px;
          font-family: var(--font-num);
          font-size: 10.5px;
          word-break: break-all;
          color: var(--p-card-ink-2);
        }
        .pf-retry {
          font: inherit;
          font-weight: 800;
          background: none;
          border: 0;
          padding: 0;
          color: var(--clay);
          cursor: pointer;
          text-decoration: underline;
        }
        .warn-thin {
          margin-top: 12px;
          padding: 12px 14px;
          border-radius: var(--r-md);
          font-size: 12.5px;
          font-weight: 600;
          background: rgba(240, 160, 60, 0.15);
          border: 1px solid rgba(240, 160, 60, 0.4);
          color: #8a5a14;
          text-align: center;
        }
        .route-h {
          margin: 14px 0 4px;
          font-size: 10.5px;
          font-weight: 800;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--p-card-ink-3);
        }
        .route-row {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 7px 0;
          font-size: 12.5px;
          flex-wrap: wrap;
        }
        .route-row .pct {
          font-family: var(--font-num);
          font-weight: 800;
          width: 38px;
          flex: none;
          color: var(--clay);
        }
        .route-row .path {
          display: flex;
          align-items: center;
          gap: 5px;
          flex-wrap: wrap;
          font-weight: 700;
        }
        .route-row .path .sep {
          color: var(--ink-3);
        }
        .route-row .ven {
          margin-left: auto;
          font-size: 11.5px;
          color: var(--p-card-ink-3);
        }
        .stat-badges {
          display: flex;
          justify-content: space-around;
          gap: 10px;
          margin: 16px 0 4px;
        }
        .stat-badges .sb {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          font-weight: 800;
          letter-spacing: 0.05em;
          color: #1e6b40;
        }
        .sb .ck {
          width: 26px;
          height: 26px;
          border-radius: 50%;
          background: var(--moss);
          color: #fff;
          display: grid;
          place-items: center;
          font-size: 13px;
        }
        .tid-panel {
          position: relative;
          margin-top: 26px;
          padding: 22px 16px 16px;
          border-radius: var(--r-md);
          background: rgba(255, 255, 255, 0.55);
          border: 1px solid rgba(44, 26, 12, 0.08);
        }
        .tid-tag {
          position: absolute;
          top: -12px;
          left: 14px;
          font-size: 10.5px;
          font-weight: 800;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          background: var(--amber);
          color: #3d2410;
          padding: 4px 10px;
          border-radius: 8px;
          box-shadow: 0 2px 0 rgba(42, 24, 10, 0.25);
        }
        .tid-tools {
          position: absolute;
          top: -14px;
          right: 12px;
          display: flex;
          gap: 6px;
        }
        .tid-hash {
          font-family: var(--font-num);
          font-size: 12.5px;
          word-break: break-all;
          color: var(--p-card-ink);
        }
        .suc-visual {
          display: grid;
          place-items: center;
          margin: 10px 0 4px;
          position: relative;
        }
        .suc-check {
          width: 74px;
          height: 74px;
          border-radius: 50%;
          background: var(--moss);
          color: #fff;
          display: grid;
          place-items: center;
          box-shadow: 0 4px 0 rgba(30, 80, 45, 0.5),
            inset 0 2px 0 rgba(255, 255, 255, 0.35);
        }
        .suc-mole {
          width: 96px;
          height: 96px;
        }
      `}</style>
    </div>
  );
}
