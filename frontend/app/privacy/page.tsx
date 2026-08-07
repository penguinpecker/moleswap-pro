import Image from "next/image";
import { NavBar } from "@/screens/shared";

export default function PrivacyPage() {
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
          <h1 className="text-peach-300 text-shadow-header font-family-ThaleahFat text-2xl font-bold tracking-widest uppercase sm:text-5xl">Privacy Policy</h1>
          <Image src="/quest/header-quest-bg.png" alt="Header" width={200} height={200} className="absolute inset-0 left-0 z-[-1] h-full w-full" />
        </div>

        <div className="relative mb-6">
          <Image src="/quest/Quest-BG.png" alt="Background" width={200} height={200} className="absolute inset-0 z-0 h-full w-full object-fill" />
          <div className="relative z-10 space-y-5 px-6 pt-16 pb-10 sm:px-10">
            <p className="font-family-ThaleahFat text-peach-300/60 text-sm">Last updated: 2/27/2026</p>

            <div>
              <h3 className="text-peach-300 text-shadow-header font-family-ThaleahFat mb-2 text-lg tracking-wider uppercase sm:text-2xl">1. Introduction</h3>
              <p className="font-family-ThaleahFat text-peach-300/70 text-sm leading-relaxed sm:text-base">MoleSwap (&ldquo;we,&rdquo; &ldquo;our,&rdquo; or &ldquo;us&rdquo;) respects your privacy. This Privacy Policy describes how we collect, use, and protect information when you use our decentralized exchange platform and related services.</p>
            </div>
            <div>
              <h3 className="text-peach-300 text-shadow-header font-family-ThaleahFat mb-2 text-lg tracking-wider uppercase sm:text-2xl">2. Information We Collect</h3>
              <p className="font-family-ThaleahFat text-peach-300/70 text-sm leading-relaxed sm:text-base">We may collect: (a) wallet addresses and transaction data when you connect and use the Platform; (b) information you provide when linking social accounts (e.g., Twitter) or signing messages; (c) usage data such as IP address and device information; (d) cookies and similar technologies for session and preference management.</p>
            </div>
            <div>
              <h3 className="text-peach-300 text-shadow-header font-family-ThaleahFat mb-2 text-lg tracking-wider uppercase sm:text-2xl">3. How We Use Your Information</h3>
              <p className="font-family-ThaleahFat text-peach-300/70 text-sm leading-relaxed sm:text-base">We use collected information to operate and improve the Platform, authenticate users, prevent fraud, comply with legal obligations, and communicate with you about the service. We do not sell your personal information to third parties.</p>
            </div>
            <div>
              <h3 className="text-peach-300 text-shadow-header font-family-ThaleahFat mb-2 text-lg tracking-wider uppercase sm:text-2xl">4. Blockchain & Decentralization</h3>
              <p className="font-family-ThaleahFat text-peach-300/70 text-sm leading-relaxed sm:text-base">Transactions you conduct on-chain are public and permanent. Wallet addresses and related on-chain activity may be visible to anyone. We do not control third-party blockchains or wallets.</p>
            </div>
            <div>
              <h3 className="text-peach-300 text-shadow-header font-family-ThaleahFat mb-2 text-lg tracking-wider uppercase sm:text-2xl">5. Data Retention & Security</h3>
              <p className="font-family-ThaleahFat text-peach-300/70 text-sm leading-relaxed sm:text-base">We retain information only as long as necessary to provide the service and fulfill legal obligations. We implement reasonable technical and organizational measures to protect your data; however, no system is completely secure.</p>
            </div>
            <div>
              <h3 className="text-peach-300 text-shadow-header font-family-ThaleahFat mb-2 text-lg tracking-wider uppercase sm:text-2xl">6. Your Rights & Contact</h3>
              <p className="font-family-ThaleahFat text-peach-300/70 text-sm leading-relaxed sm:text-base">Depending on your jurisdiction, you may have rights to access, correct, or delete your personal data. To exercise these rights or ask questions about this Privacy Policy, contact us through our official website or social channels.</p>
            </div>
            <p className="font-family-ThaleahFat text-peach-300/70 text-sm leading-relaxed sm:text-base">By using MoleSwap, you acknowledge that you have read and understood this Privacy Policy.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
