import Image from "next/image";
import { NavBar } from "@/screens/shared";

export default function TermsPage() {
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
          <h1 className="text-peach-300 text-shadow-header font-family-ThaleahFat text-2xl font-bold tracking-widest uppercase sm:text-5xl">Terms of Use</h1>
          <Image src="/quest/header-quest-bg.png" alt="Header" width={200} height={200} className="absolute inset-0 left-0 z-[-1] h-full w-full" />
        </div>

        <div className="relative mb-6">
          <Image src="/quest/Quest-BG.png" alt="Background" width={200} height={200} className="absolute inset-0 z-0 h-full w-full object-fill" />
          <div className="relative z-10 space-y-5 px-6 pt-16 pb-10 sm:px-10">
            <p className="font-family-ThaleahFat text-peach-300/60 text-sm">Last updated: 2/27/2026</p>

            <div>
              <h3 className="text-peach-300 text-shadow-header font-family-ThaleahFat mb-2 text-lg tracking-wider uppercase sm:text-2xl">1. Acceptance of Terms</h3>
              <p className="font-family-ThaleahFat text-peach-300/70 text-sm leading-relaxed sm:text-base">By accessing or using MoleSwap (&ldquo;the Platform&rdquo;), you agree to be bound by these Terms of Use. If you do not agree, do not use the Platform.</p>
            </div>
            <div>
              <h3 className="text-peach-300 text-shadow-header font-family-ThaleahFat mb-2 text-lg tracking-wider uppercase sm:text-2xl">2. Eligibility</h3>
              <p className="font-family-ThaleahFat text-peach-300/70 text-sm leading-relaxed sm:text-base">You must be of legal age in your jurisdiction and not prohibited from using decentralized finance or swap services. You are responsible for compliance with local laws.</p>
            </div>
            <div>
              <h3 className="text-peach-300 text-shadow-header font-family-ThaleahFat mb-2 text-lg tracking-wider uppercase sm:text-2xl">3. Use of the Platform</h3>
              <p className="font-family-ThaleahFat text-peach-300/70 text-sm leading-relaxed sm:text-base">MoleSwap provides a decentralized exchange interface. You use the Platform at your own risk. We do not custody your funds; you retain control of your wallet and assets. Transactions are final and irreversible once confirmed on-chain.</p>
            </div>
            <div>
              <h3 className="text-peach-300 text-shadow-header font-family-ThaleahFat mb-2 text-lg tracking-wider uppercase sm:text-2xl">4. No Financial Advice</h3>
              <p className="font-family-ThaleahFat text-peach-300/70 text-sm leading-relaxed sm:text-base">Nothing on the Platform constitutes financial, legal, or tax advice. You are solely responsible for your trading and investment decisions.</p>
            </div>
            <div>
              <h3 className="text-peach-300 text-shadow-header font-family-ThaleahFat mb-2 text-lg tracking-wider uppercase sm:text-2xl">5. Disclaimer of Warranties</h3>
              <p className="font-family-ThaleahFat text-peach-300/70 text-sm leading-relaxed sm:text-base">The Platform is provided &ldquo;as is&rdquo; without warranties of any kind. We do not guarantee uninterrupted access, accuracy of data, or fitness for a particular purpose.</p>
            </div>
            <div>
              <h3 className="text-peach-300 text-shadow-header font-family-ThaleahFat mb-2 text-lg tracking-wider uppercase sm:text-2xl">6. Limitation of Liability</h3>
              <p className="font-family-ThaleahFat text-peach-300/70 text-sm leading-relaxed sm:text-base">To the fullest extent permitted by law, MoleSwap and its affiliates shall not be liable for any indirect, incidental, special, or consequential damages arising from your use of the Platform or any transactions conducted through it.</p>
            </div>
            <p className="font-family-ThaleahFat text-peach-300/70 text-sm leading-relaxed sm:text-base">For questions about these terms, contact us via our official channels. By continuing to use MoleSwap, you acknowledge that you have read and agree to these Terms of Use.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
