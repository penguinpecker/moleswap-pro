"use client";
import Image from "next/image";
import { NavBar } from "@/screens/shared";

export default function StaticPageLayout({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen w-full flex-col items-center gap-4">
      {/* Background */}
      <div className="fixed inset-0 flex h-[40vh] flex-col">
        <div className="h-[25%] bg-[#39BBE3]"></div>
        <div className="h-[25%] bg-[#6ED2F0]"></div>
        <div className="h-[25%] bg-[#AEE5F5]"></div>
        <div className="h-[25%] bg-[#E9F9FE]"></div>
      </div>
      <Image
        src="/profile/Grass.png"
        alt="Grass"
        width={200}
        height={200}
        className="fixed bottom-[32vh] z-10 h-full max-h-[15vh] w-full object-cover sm:bottom-[35vh] sm:max-h-[20vh]"
      />
      <Image
        src="/profile/profile-brick.png"
        alt="Brick"
        width={200}
        height={200}
        className="fixed bottom-0 h-full max-h-[45vh] w-full object-cover sm:max-h-[50vh]"
      />

      {/* Navbar */}
      <div className="relative z-50 mx-auto mt-2 block w-full px-2 sm:mt-4 sm:px-4">
        <NavBar />
      </div>

      {/* Content */}
      <div className="relative z-20 mx-auto w-full max-w-5xl flex-1 px-1 sm:px-2 md:p-6">
        {/* Header */}
        <div className="relative top-[40px] z-10 mx-auto w-[85%] rounded-lg px-4 py-3 text-center sm:w-[75%] sm:px-6 sm:py-4">
          <h1 className="text-peach-300 text-shadow-header font-family-ThaleahFat text-2xl font-bold tracking-widest uppercase sm:text-5xl">
            {title}
          </h1>
          <Image
            src="/quest/header-quest-bg.png"
            alt="Header Background"
            width={200}
            height={200}
            className="absolute inset-0 left-0 z-[-1] h-full w-full"
          />
        </div>

        {/* Panel */}
        <div className="relative mb-6 h-full">
          <Image
            src="/quest/Quest-BG.png"
            alt="Background"
            width={200}
            height={200}
            className="absolute inset-0 z-0 h-full w-full object-fill"
          />
          <div className="relative z-10 mt-12 px-6 pt-6 pb-10 sm:px-10 sm:pt-8 sm:pb-14">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
