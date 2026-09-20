import CampaignForm from '../../../../components/campaign-form';

export default async function EditCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CampaignForm campaignId={id} />;
}
