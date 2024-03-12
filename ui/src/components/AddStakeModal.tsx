import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { useWallet } from '@txnlab/use-wallet'
import * as React from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'
import {
  addStake,
  doesStakerNeedToPayMbr,
  isNewStakerToValidator,
  mbrQueryOptions,
} from '@/api/contracts'
import { AlgoDisplayAmount } from '@/components/AlgoDisplayAmount'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Validator } from '@/interfaces/validator'

const formSchema = z.object({
  amountToStake: z.string().refine((val) => Number(val) >= 1, {
    message: 'Amount to stake must be at least 1',
  }),
})

interface AddStakeModalProps {
  validator: Validator
  disabled?: boolean
}

export function AddStakeModal({ validator, disabled }: AddStakeModalProps) {
  const [isOpen, setIsOpen] = React.useState<boolean>(false)

  const queryClient = useQueryClient()
  const router = useRouter()
  const { signer, activeAddress } = useWallet()

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      amountToStake: '',
    },
  })

  const { errors } = form.formState

  const mbrQuery = useQuery(mbrQueryOptions)

  const stakerMbr = mbrQuery.data?.stakerMbr

  const toastIdRef = React.useRef(`toast-${Date.now()}-${Math.random()}`)
  const TOAST_ID = toastIdRef.current

  const onSubmit = async (data: z.infer<typeof formSchema>) => {
    const toastId = `${TOAST_ID}-add-stake`

    try {
      setIsOpen(false)

      if (!activeAddress) {
        throw new Error('No wallet connected')
      }

      const amountToStake = AlgoAmount.Algos(Number(data.amountToStake)).microAlgos

      const { stakerMbr } = await queryClient.ensureQueryData(mbrQueryOptions)
      const isMbrRequired = await doesStakerNeedToPayMbr(activeAddress)
      const totalAmount = isMbrRequired ? amountToStake + stakerMbr : amountToStake

      const isNewStaker = await isNewStakerToValidator(
        validator.id,
        activeAddress,
        validator.minStake,
      )

      toast.loading('Sign transactions to add stake...', { id: toastId })

      const { poolId } = await addStake(validator.id, totalAmount, signer, activeAddress)

      toast.success(`Stake added to pool ${poolId}!`, {
        id: toastId,
        duration: 5000,
      })

      queryClient.setQueryData<Validator>(
        ['validator', { validatorId: validator.id.toString() }],
        (prevData) => {
          if (!prevData) {
            return prevData
          }

          return {
            ...prevData,
            numStakers: isNewStaker ? prevData.numStakers + 1 : prevData.numStakers,
            totalStaked: prevData.totalStaked + totalAmount,
          }
        },
      )

      queryClient.setQueryData<Validator[]>(['validators'], (prevData) => {
        if (!prevData) {
          return prevData
        }

        return prevData.map((v: Validator) => {
          if (v.id === validator.id) {
            return {
              ...v,
              numStakers: isNewStaker ? v.numStakers + 1 : v.numStakers,
              totalStaked: v.totalStaked + totalAmount,
            }
          }

          return v
        })
      })

      router.invalidate()
    } catch (error) {
      toast.error('Failed to add stake to pool', { id: toastId })
      console.error(error)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={disabled}>
          Stake
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Stake to Validator {validator.id}</DialogTitle>
          <DialogDescription>
            This will send your ALGO to the validator and stake it in one of their pools.
          </DialogDescription>
        </DialogHeader>
        <div>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="w-2/3 space-y-6">
              <FormField
                control={form.control}
                name="amountToStake"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Amount to Stake</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormDescription>
                      Enter the amount you wish to stake.{' '}
                      {stakerMbr && (
                        <span>
                          NOTE: First time stakers will need to pay{' '}
                          <AlgoDisplayAmount amount={stakerMbr} microalgos /> in fees.
                        </span>
                      )}
                    </FormDescription>
                    <FormMessage>{errors.amountToStake?.message}</FormMessage>
                  </FormItem>
                )}
              />
              <Button type="submit">Submit</Button>
            </form>
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  )
}
