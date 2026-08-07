"use client";
import { ArrowLeft, TicketX } from "lucide-react";
import { DappStep } from ".";
import Image from "next/image";
import type { RelayCurrency, RelayChain } from "@/lib/relay/api";

interface SwapSuccessPageProps {
  onNext: (step: DappStep, data?: any) => void;
  swapData: any;
}

export const SwapSuccessPage = ({ onNext, swapData }: SwapSuccessPageProps) => {
  const handleTxnInfo = () => {
    onNext("transaction-info", swapData);
  };

  const handleDone = () => {
    onNext("exchange");
  };

  // Calculate tickets based on swap amount (4 tickets for successful swap)
  const ticketsReceived = 4;

  // Get actual values from swap data.
  //
  // toChainName is hard-coded to "Push Chain" — swap proceeds always land as
  // a PRC-20 on Push Chain regardless of what origin chain the destination
  // PRC-20 represents. Previously the success page read toChain.displayName
  // (Ethereum / Solana / etc.) which lied: a pETH swap arrives on Push, not
  // Ethereum. Flip back to origin-chain labelling once outbound Route 2 is
  // wired.
  const expectedOut = swapData.expectedOut || "0";
  const feesLabel = swapData.feesLabel || "";
  const toTokenSymbol = swapData.toTokenMeta?.symbol || swapData.toToken || "";
  const toChainName = "Push Chain";

  // Calculate percentage change (placeholder for now, could be calculated from rate)
  const percentageChange = "+0.31%";

  // Calculate USD value from expectedOut (simplified - could use actual price API)
  // For now, if it's USDC/USDT, the amount is approximately the USD value
  const isStablecoin =
    toTokenSymbol?.toUpperCase() === "USDC" ||
    toTokenSymbol?.toUpperCase() === "USDT";
  const usdValue = isStablecoin
    ? expectedOut
    : parseFloat(expectedOut).toFixed(2);

  return (
    <div className="flex w-full flex-1 flex-col p-2 sm:max-w-3xl sm:p-6">
      {/* Header with Back Button */}
      <div className="font-family-ThaleahFat relative top-[40px] z-10 mx-auto flex w-[85%] items-center justify-center rounded-lg px-6 py-4 text-center">
        <button
          onClick={() => onNext("transaction-info")}
          className="border-ground-button-border bg-ground-button absolute left-4 cursor-pointer justify-center rounded border-2 p-1 text-yellow-100 hover:scale-105"
        >
          <ArrowLeft className="h-6 w-6 text-yellow-100" />
        </button>

        <h1 className="text-peach-300 text-shadow-header mx-auto text-3xl font-bold tracking-widest uppercase sm:text-5xl">
          EXCHANGE
        </h1>
        <Image
          src="/quest/header-quest-bg.png"
          alt="Profile"
          width={200}
          height={200}
          className="absolute inset-0 left-0 z-[-1] h-full w-full"
        />
      </div>
      <div className="relative mb-6 block h-full">
        <Image
          src="/quest/Quest-BG.png"
          alt="Profile"
          width={200}
          height={200}
          className="absolute inset-0 z-0 h-full w-full object-fill"
        />
        <div className="relative z-50 mx-auto mt-12 mb-6 grid w-full grid-cols-1 gap-4 p-4 sm:w-[85%]">
          {/* Success Content */}
          <div className="text-center">
            {/* Success Icon */}

            <div className="relative mt-12 mb-8 flex items-center justify-center">
              <Image
                src="/dapp/success-mole.gif"
                alt="Profile"
                width={100}
                height={100}
                className="absolute top-[-50%] left-[50%] z-10 -translate-x-1/2 transform"
              />
              <Image
                src="/dapp/Check-mark-swap-completed.png"
                alt="Profile"
                width={100}
                height={100}
                className="z-20"
              />
            </div>

            {/* Success Message */}
            <h2 className="font-family-ThaleahFat mb-2 text-4xl text-white uppercase">
              SWAP SUCCESSFUL
            </h2>

            <p className="font-family-ThaleahFat -mb-3 text-lg text-stone-300">
              This transaction has been successfully processed.
            </p>
            <p className="font-family-ThaleahFat mb-3 text-lg text-stone-300">
              Please check the transaction info for more details.
            </p>
            <p className="font-family-ThaleahFat mb-6 text-lg text-stone-300">
              Thanks for using Moleswap!
            </p>

            {/* Token Amount */}
            <div className="relative z-50 p-4">
              <div className="px-4">
                <div className="flex items-center">
                  <div className="border-ground-button-border bg-ground-button mr-3 flex h-10 w-10 items-center justify-center overflow-hidden rounded border-2">
                    <Image
                      src={
                        swapData.toTokenMeta?.logoURI ||
                        swapData.toChain?.iconUrl ||
                        swapData.toChain?.logoUrl ||
                        "/placeholder-logo.png"
                      }
                      alt="To token"
                      width={40}
                      height={40}
                      className="h-full w-full object-cover"
                    />
                  </div>
                  <div className="flex flex-col items-start">
                    <div className="font-family-ThaleahFat text-3xl text-zinc-100">
                      {expectedOut}
                    </div>
                    <div className="text-sm font-semibold text-stone-300">
                      ${usdValue} • {percentageChange} • {toTokenSymbol} on{" "}
                      {toChainName}
                    </div>
                    <div className="text-xs font-semibold text-[#BCBCBC]">
                      ETA:{" "}
                      {(swapData.etaSeconds ?? null) !== null
                        ? `${swapData.etaSeconds}s`
                        : "-"}
                    </div>
                  </div>
                </div>
              </div>
              <Image
                src="/quest/header-quest-bg.png"
                alt="Profile"
                width={200}
                height={200}
                className="absolute inset-0 left-0 z-[-1] h-full w-full"
              />
            </div>

            {/* Tickets Received */}
            {/* <div className="my-8 flex items-center justify-center">
              <span className="mr-4 -rotate-45 text-2xl text-pink-400">
                <TicketX className="h-8 w-8" />
              </span>
              <span className="font-family-ThaleahFat text-peach-300 text-3xl">
                X{ticketsReceived} TICKETS RECEIVED!
              </span>
            </div> */}
          </div>

          {/* Action Buttons */}
          <div className="flex gap-4 max-sm:flex-col">
            <button
              onClick={handleTxnInfo}
              className="relative w-full cursor-pointer rounded py-4 text-xl font-bold text-white transition-all hover:scale-105"
            >
              <span> TXN INFO</span>
              <Image
                src="/dapp/connect-wallet.png"
                alt="Profile"
                width={200}
                height={200}
                className="absolute inset-0 z-[-1] h-full w-full object-fill"
              />
            </button>

            <button
              onClick={handleDone}
              className="relative w-full cursor-pointer rounded py-4 text-xl font-bold text-white transition-all hover:scale-105"
            >
              <span> DONE </span>
              <Image
                src="/dapp/done.png"
                alt="Profile"
                width={200}
                height={200}
                className="absolute inset-0 z-[-1] h-full w-full object-fill"
              />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
