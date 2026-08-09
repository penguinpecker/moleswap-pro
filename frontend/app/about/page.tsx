import Image from "next/image";
import { NavBar } from "@/screens/shared";

export default function AboutPage() {
  return (
    <div className="relative flex min-h-screen w-full flex-col items-center gap-4">
      <div className="fixed inset-0 flex h-[40vh] flex-col">
        <div className="h-[25%] bg-[#39BBE3]"></div>
        <div className="h-[25%] bg-[#6ED2F0]"></div>
        <div className="h-[25%] bg-[#AEE5F5]"></div>
        <div className="h-[25%] bg-[#E9F9FE]"></div>
      </div>
      <Image src="/profile/Grass.png" alt="Grass" width={200} height={200} className="fixed bottom-[32vh] z-10 h-full max-h-[15vh] w-full object-cover sm:bottom-[35vh] sm:max-h-[20vh]" />
      <Image src="/profile/profile-brick.png" alt="Brick" width={200} height={200} className="fixed bottom-0 h-full max-h-[45vh] w-full object-cover sm:max-h-[50vh]" />

      <div className="relative z-50 mx-auto mt-2 block w-full px-2 sm:mt-4 sm:px-4">
        <NavBar />
      </div>

      <div className="relative z-20 mx-auto w-full max-w-5xl flex-1 px-1 sm:px-2 md:p-6">
        <div className="relative top-[40px] z-10 mx-auto w-[85%] rounded-lg px-4 py-3 text-center sm:w-[75%] sm:px-6 sm:py-4">
          <h1 className="text-peach-300 text-shadow-header font-family-ThaleahFat text-2xl font-bold tracking-widest uppercase sm:text-5xl">About MoleSwap</h1>
          <Image src="/quest/header-quest-bg.png" alt="Header" width={200} height={200} className="absolute inset-0 left-0 z-[-1] h-full w-full" />
        </div>

        <div className="relative mb-6">
          <Image src="/quest/Quest-BG.png" alt="Background" width={200} height={200} className="absolute inset-0 z-0 h-full w-full object-fill" />
          <div className="relative z-10 space-y-6 px-6 pt-16 pb-10 sm:px-10">
            <div className="flex justify-center">
              <Image src="/profile/profile-logo.png" alt="MoleSwap Logo" width={100} height={100} className="h-24 w-24 sm:h-32 sm:w-32" />
            </div>

            <h2 className="text-peach-300 text-shadow-header font-family-ThaleahFat text-center text-xl tracking-wider uppercase sm:text-3xl">The Underground DEX Built on Robinhood Chain</h2>
            <p className="font-family-ThaleahFat text-peach-300/80 text-center text-sm sm:text-lg">Where seamless trading meets a vibrant SocialFi experience.</p>

            <div className="space-y-5">
              <div>
                <h3 className="text-peach-300 text-shadow-header font-family-ThaleahFat mb-2 text-lg tracking-wider uppercase sm:text-2xl">What is MoleSwap?</h3>
                <p className="font-family-ThaleahFat text-peach-300/70 text-sm leading-relaxed sm:text-base">MoleSwap is a next-generation ecosystem designed for traders who demand efficiency, community, and a fresh take on decentralized finance. Every swap is a strategic move, every connection strengthens the network, and every interaction brings a new layer of value to the community.</p>
              </div>
              <div>
                <h3 className="text-peach-300 text-shadow-header font-family-ThaleahFat mb-2 text-lg tracking-wider uppercase sm:text-2xl">DEX Aggregator & AMM</h3>
                <p className="font-family-ThaleahFat text-peach-300/70 text-sm leading-relaxed sm:text-base">MoleSwap is a DEX aggregator and automated liquidity manager on Robinhood Chain. It routes every trade across all live venues and settles through an immutable executor that guarantees your minimum output on-chain. One swap, best price, on-chain guarantee.</p>
              </div>
              <div>
                <h3 className="text-peach-300 text-shadow-header font-family-ThaleahFat mb-2 text-lg tracking-wider uppercase sm:text-2xl">Community & SocialFi</h3>
                <p className="font-family-ThaleahFat text-peach-300/70 text-sm leading-relaxed sm:text-base">Beyond trading, MoleSwap is built around its community. Members earn rewards, climb leaderboards, build on-chain reputation, and engage with fellow participants in a community-first ecosystem. The mission is to transform DeFi from a solitary experience into a social movement.</p>
              </div>
              <p className="font-family-ThaleahFat text-peach-300/70 text-sm leading-relaxed sm:text-base">Whether for seasoned traders or newcomers exploring decentralized finance for the first time, MoleSwap offers a tunnel into the future of trading. Time to dig in.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
