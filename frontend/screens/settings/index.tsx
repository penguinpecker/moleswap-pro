"use client";
import React from "react";
import { BackgroundImage, NavBar } from "../shared";
import Image from "next/image";
import { ArrowLeft, ArrowUpDown, Move } from "lucide-react";
import { useRouter } from "next/navigation";

const Settings = ({
  setShowSettings,
}: {
  setShowSettings: React.Dispatch<React.SetStateAction<boolean>>;
}) => {
  const showReceive = true;
  const router = useRouter();
  const onBack = () => router.back();
  const [expandedCard, setExpandedCard] = React.useState<string | null>(null);
  const [routePriority, setRoutePriority] = React.useState("BEST RETURN");
  const [maxSlippage, setMaxSlippage] = React.useState("AUTO");
  const [gasPrice, setGasPrice] = React.useState("NORMAL");

  const toggleCard = (cardId: string) => {
    setExpandedCard(expandedCard === cardId ? null : cardId);
  };

  return (
    <div className="relative flex w-full flex-col items-center gap-4">
      <div className="relative z-20 mb-[40%] flex w-full flex-1 items-center justify-center sm:mb-[8%]">
        {" "}
        <div className="flex w-full max-w-3xl flex-1 flex-col px-2 sm:p-6">
          {/* Header */}
          <div className="font-family-ThaleahFat relative top-[40px] z-10 mx-auto flex w-[85%] items-center justify-center rounded-lg px-3 py-4 text-center sm:px-6">
            <button
              onClick={() => setShowSettings(false)}
              className="border-ground-button-border bg-ground-button absolute left-2 cursor-pointer justify-center rounded border-2 p-1 text-yellow-100 hover:scale-105 sm:left-4"
            >
              <ArrowLeft className="text-peach-400 h-5 w-5 sm:h-6 sm:w-6" />
            </button>

            <h1 className="text-peach-300 text-shadow-header mx-auto text-2xl font-bold tracking-widest uppercase sm:text-3xl md:text-5xl">
              SETTINGS
            </h1>
            <Image
              src="/quest/header-quest-bg.png"
              alt="Profile"
              width={200}
              height={200}
              className="absolute inset-0 left-0 z-[-1] h-full w-full"
            />
          </div>

          {/* Main Exchange Section */}
          <div className="relative mb-6 block h-full">
            <Image
              src="/quest/Quest-BG.png"
              alt="Profile"
              width={200}
              height={200}
              className="absolute inset-0 z-0 h-full w-full object-fill"
            />

            {/* Settings Cards */}
            <div className="relative z-50 mx-auto mt-12 mb-6 grid w-full grid-cols-1 gap-3 p-3 sm:w-[85%] sm:gap-4 sm:p-4">
              {/* Route Priority */}
              <div
                className="relative z-10 mx-auto w-full cursor-pointer rounded-lg px-4 py-3 text-center transition-opacity hover:opacity-90 sm:w-[90%] sm:px-6 sm:py-4"
                onClick={() => toggleCard("route")}
              >
                <div className="flex items-center justify-between gap-2 sm:gap-4">
                  <div className="flex items-center gap-2 sm:gap-4">
                    <Image
                      src="/settings/route.svg"
                      alt="Profile"
                      width={24}
                      height={24}
                      className="h-5 w-5 text-white sm:h-7 sm:w-7"
                    />

                    <div className="text-left">
                      <h2 className="font-family-ThaleahFat text-xl tracking-widest text-white uppercase sm:text-2xl md:text-3xl">
                        Route Priority
                      </h2>
                    </div>
                  </div>
                  <p className="font-family-ThaleahFat text-base font-medium tracking-widest text-[#B0B0B0] uppercase sm:text-xl md:text-2xl">
                    {expandedCard === "route" ? "" : routePriority}
                  </p>
                </div>
                {expandedCard === "route" && (
                  <div className="my-2 mt-3 flex sm:mt-4">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setRoutePriority("BEST RETURN");
                      }}
                      className={`font-family-ThaleahFat flex-1 cursor-pointer rounded-l-xs px-2 py-1 text-base tracking-widest uppercase transition-colors sm:px-3 sm:text-lg md:text-2xl ${
                        routePriority === "BEST RETURN"
                          ? "bg-[#F4D03F] text-black"
                          : "bg-[#3D2817] text-[#B0B0B0] hover:bg-[#4D3827]"
                      }`}
                    >
                      BEST RETURN
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setRoutePriority("FASTEST");
                      }}
                      className={`font-family-ThaleahFat flex-1 cursor-pointer rounded-r-xs px-2 py-1 text-base tracking-widest uppercase transition-colors sm:px-3 sm:text-lg md:text-2xl ${
                        routePriority === "FASTEST"
                          ? "bg-[#F4D03F] text-black"
                          : "bg-[#3D2817] text-[#B0B0B0] hover:bg-[#4D3827]"
                      }`}
                    >
                      FASTEST
                    </button>
                  </div>
                )}
                <Image
                  src="/quest/header-quest-bg.png"
                  alt="Profile"
                  width={200}
                  height={200}
                  className="absolute inset-0 left-0 z-[-1] h-full w-full"
                />
              </div>

              {/* Max Slippage */}
              <div
                className="relative z-10 mx-auto w-full cursor-pointer rounded-lg px-4 py-3 text-center transition-opacity hover:opacity-90 sm:w-[90%] sm:px-6 sm:py-4"
                onClick={() => toggleCard("slippage")}
              >
                <div className="flex items-center justify-between gap-2 sm:gap-4">
                  <div className="flex items-center gap-2 sm:gap-4">
                    <Image
                      src="/settings/divide.svg"
                      alt="Profile"
                      width={24}
                      height={24}
                      className="h-4 w-4 text-white sm:h-5 sm:w-5"
                    />
                    <div className="text-left">
                      <h2 className="font-family-ThaleahFat text-xl tracking-widest text-white uppercase sm:text-2xl md:text-3xl">
                        Max Slippage
                      </h2>
                    </div>
                  </div>
                  <p className="font-family-ThaleahFat text-base font-medium tracking-widest text-[#B0B0B0] uppercase sm:text-xl md:text-2xl">
                    {expandedCard === "slippage" ? "" : maxSlippage}
                  </p>
                </div>
                {expandedCard === "slippage" && (
                  <div className="my-2 mt-3 flex sm:mt-4">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setMaxSlippage("AUTO");
                      }}
                      className={`font-family-ThaleahFat flex-1 cursor-pointer rounded-l-xs px-2 py-1 text-base tracking-widest uppercase transition-colors sm:px-3 sm:text-lg md:text-2xl ${
                        maxSlippage === "AUTO"
                          ? "bg-[#F4D03F] text-black"
                          : "bg-[#3D2817] text-[#B0B0B0] hover:bg-[#4D3827]"
                      }`}
                    >
                      AUTO
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setMaxSlippage("0.5");
                      }}
                      className={`font-family-ThaleahFat flex-1 cursor-pointer rounded-r-xs px-2 py-1 text-base tracking-widest uppercase transition-colors sm:px-3 sm:text-lg md:text-2xl ${
                        maxSlippage === "0.5"
                          ? "bg-[#F4D03F] text-black"
                          : "bg-[#3D2817] text-[#B0B0B0] hover:bg-[#4D3827]"
                      }`}
                    >
                      0.5
                    </button>
                  </div>
                )}
                <Image
                  src="/quest/header-quest-bg.png"
                  alt="Profile"
                  width={200}
                  height={200}
                  className="absolute inset-0 left-0 z-[-1] h-full w-full"
                />
              </div>

              {/* Gas Price */}
              <div
                className="relative z-10 mx-auto w-full cursor-pointer rounded-lg px-4 py-3 text-center transition-opacity hover:opacity-90 sm:w-[90%] sm:px-6 sm:py-4"
                onClick={() => toggleCard("gas")}
              >
                <div className="flex items-center justify-between gap-2 sm:gap-4">
                  <div className="flex items-center gap-2 sm:gap-4">
                    <Image
                      src="/settings/gas.svg"
                      alt="Profile"
                      width={24}
                      height={24}
                      className="h-5 w-5 text-white sm:h-7 sm:w-7"
                    />
                    <div className="text-left">
                      <h2 className="font-family-ThaleahFat text-xl tracking-widest text-white uppercase sm:text-2xl md:text-3xl">
                        Gas Price
                      </h2>
                    </div>
                  </div>
                  <p className="font-family-ThaleahFat text-base font-medium tracking-widest text-[#B0B0B0] uppercase sm:text-xl md:text-2xl">
                    {expandedCard === "gas" ? "" : gasPrice}
                  </p>
                </div>
                {expandedCard === "gas" && (
                  <div className="my-2 mt-3 flex sm:mt-4">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setGasPrice("SLOW");
                      }}
                      className={`font-family-ThaleahFat flex-1 cursor-pointer rounded-l-xs px-2 py-1 text-base tracking-widest uppercase transition-colors sm:px-3 sm:text-lg md:text-2xl ${
                        gasPrice === "SLOW"
                          ? "bg-[#F4D03F] text-black"
                          : "bg-[#3D2817] text-[#B0B0B0] hover:bg-[#4D3827]"
                      }`}
                    >
                      SLOW
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setGasPrice("NORMAL");
                      }}
                      className={`font-family-ThaleahFat flex-1 cursor-pointer px-2 py-1 text-base tracking-widest uppercase transition-colors sm:px-3 sm:text-lg md:text-2xl ${
                        gasPrice === "NORMAL"
                          ? "bg-[#F4D03F] text-black"
                          : "bg-[#3D2817] text-[#B0B0B0] hover:bg-[#4D3827]"
                      }`}
                    >
                      NORMAL
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setGasPrice("FAST");
                      }}
                      className={`font-family-ThaleahFat flex-1 cursor-pointer rounded-r-xs px-2 py-1 text-base tracking-widest uppercase transition-colors sm:px-3 sm:text-lg md:text-2xl ${
                        gasPrice === "FAST"
                          ? "bg-[#F4D03F] text-black"
                          : "bg-[#3D2817] text-[#B0B0B0] hover:bg-[#4D3827]"
                      }`}
                    >
                      FAST
                    </button>
                  </div>
                )}
                <Image
                  src="/quest/header-quest-bg.png"
                  alt="Profile"
                  width={200}
                  height={200}
                  className="absolute inset-0 left-0 z-[-1] h-full w-full"
                />
              </div>

              {/* Bridges */}
              <div className="relative z-10 mx-auto w-full cursor-pointer rounded-lg px-4 py-3 text-center transition-opacity hover:opacity-90 sm:w-[90%] sm:px-6 sm:py-4">
                <div className="flex items-center justify-between gap-2 sm:gap-4">
                  <div className="flex items-center gap-2 sm:gap-4">
                    <Image
                      src="/settings/bridges.svg"
                      alt="Profile"
                      width={24}
                      height={24}
                      className="h-5 w-5 text-white sm:h-7 sm:w-7"
                    />

                    <div className="text-left">
                      <h2 className="font-family-ThaleahFat text-xl tracking-widest text-white uppercase sm:text-2xl md:text-3xl">
                        Bridges
                      </h2>
                    </div>
                  </div>
                  <p className="font-family-ThaleahFat text-base font-medium tracking-widest text-[#B0B0B0] uppercase sm:text-xl md:text-2xl">
                    20/20
                  </p>
                </div>
                <Image
                  src="/quest/header-quest-bg.png"
                  alt="Profile"
                  width={200}
                  height={200}
                  className="absolute inset-0 left-0 z-[-1] h-full w-full"
                />
              </div>

              {/* Exchanges */}
              <div className="relative z-10 mx-auto w-full cursor-pointer rounded-lg px-4 py-3 text-center transition-opacity hover:opacity-90 sm:w-[90%] sm:px-6 sm:py-4">
                <div className="flex items-center justify-between gap-2 sm:gap-4">
                  <div className="flex items-center gap-2 sm:gap-4">
                    <Image
                      src="/settings/exchanges.svg"
                      alt="Profile"
                      width={24}
                      height={24}
                      className="h-5 w-5 text-white sm:h-7 sm:w-7"
                    />
                    <div className="text-left">
                      <h2 className="font-family-ThaleahFat text-xl tracking-widest text-white uppercase sm:text-2xl md:text-3xl">
                        Exchanges
                      </h2>
                    </div>
                  </div>
                  <p className="font-family-ThaleahFat text-base font-medium tracking-widest text-[#B0B0B0] uppercase sm:text-xl md:text-2xl">
                    16/16
                  </p>
                </div>
                <Image
                  src="/quest/header-quest-bg.png"
                  alt="Profile"
                  width={200}
                  height={200}
                  className="absolute inset-0 left-0 z-[-1] h-full w-full"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Settings;
