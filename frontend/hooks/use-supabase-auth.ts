"use client";

import { createClient } from '@/lib/supabase/client'
import { Session } from '@supabase/supabase-js'
import { useEffect, useState, useCallback } from 'react'

interface WalletUser {
  id: string;
  username?: string;
  name?: string;
  image?: string;
  email?: string;
}

// Supabase is now used **only** for Web3 wallet auth.
// Twitter auth is handled entirely by the MoleSwap backend.
export function useSupabaseAuth() {
  const [walletUser, setWalletUser] = useState<WalletUser | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    // Get initial session
    const getSession = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      setSession(session)
      if (session?.user) {
        const userData = extractWalletUser(session.user)
        setWalletUser(userData)
      }
      setLoading(false)
    }

    getSession()

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        setSession(session)
        if (session?.user) {
          const userData = extractWalletUser(session.user)
          setWalletUser(userData)
        } else {
          setWalletUser(null)
        }
        setLoading(false)
      }
    )

    return () => subscription.unsubscribe()
  }, [supabase])

  const signInWithWeb3 = useCallback(async () => {
    try {
      // Check if window.ethereum is available
      if (typeof window === 'undefined' || !(window as any).ethereum) {
        return { 
          data: null, 
          error: new Error('No Ethereum wallet detected. Please install MetaMask or another Web3 wallet.') 
        }
      }

      // Get current origin for URI validation
      const origin = typeof window !== 'undefined' ? window.location.origin : 'https://www.moleswap.com'
      
      const { data, error } = await supabase.auth.signInWithWeb3({
        chain: 'ethereum',
        statement: 'I accept the MoleSwap Terms of Service',
        options: {
          // Explicitly set the redirect URL to match Supabase configuration
          redirectTo: `${origin}/auth/callback`,
        },
      })
      
      if (error) {
        console.error('Supabase Web3 auth error:', error)
      }
      
      return { data, error }
    } catch (err) {
      console.error('Unexpected error during Web3 auth:', err)
      return { data: null, error: err as Error }
    }
  }, [supabase])

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut()
    if (!error) {
      setWalletUser(null)
      setSession(null)
    }
    return { error }
  }, [supabase])

  return {
    walletUser,
    session,
    loading,
    signInWithWeb3,
    signOut,
  }
}

function extractWalletUser(user: any): WalletUser {
  // Check if this is a Web3 wallet user
  const web3Identity = user.identities?.find((identity: any) => 
    identity.provider === 'web3' || identity.provider === 'ethereum'
  )
  
  if (web3Identity) {
    // Web3 wallet user - use wallet address as ID
    const walletAddress = web3Identity.identity_data?.sub || user.id
    return {
      id: walletAddress,
      username: `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`,
      name: `Wallet User`,
      image: undefined,
      email: user.email,
    }
  }
  
  // If not a Web3 identity, just fall back to generic shape
  return {
    id: user.id,
    username: user.email || user.id,
    name: user.email || 'User',
    image: undefined,
    email: user.email,
  }
}
