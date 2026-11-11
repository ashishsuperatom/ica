// Recorded shapes of OData $metadata, shared by the OData tests (test/odata-module.test.mts, test/sap-s4hana.test.mts).

// A v2 service as SAP Gateway writes it (abridged from API_BUSINESS_PARTNER): sap: attributes for labels, a date held
// as Edm.DateTime, an association with its referential constraint, a set that cannot be read on its own.
export const SAP_V2 = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" xmlns:sap="http://www.sap.com/Protocols/SAPData">
  <edmx:DataServices m:DataServiceVersion="2.0">
    <Schema Namespace="API_BUSINESS_PARTNER" xml:lang="en" sap:schema-version="1" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">
      <EntityType Name="A_BusinessPartnerType" sap:label="Business Partner" sap:content-version="1">
        <Key><PropertyRef Name="BusinessPartner"/></Key>
        <Property Name="BusinessPartner" Type="Edm.String" Nullable="false" MaxLength="10" sap:display-format="UpperCase" sap:label="Business Partner" sap:quickinfo="Business Partner Number"/>
        <Property Name="Customer" Type="Edm.String" MaxLength="10" sap:display-format="UpperCase" sap:label="Customer" sap:quickinfo="Customer Number"/>
        <Property Name="BusinessPartnerFullName" Type="Edm.String" MaxLength="81" sap:label="Name of Business Partner"/>
        <Property Name="BusinessPartnerIsBlocked" Type="Edm.Boolean" sap:label="Central Block"/>
        <Property Name="CreationDate" Type="Edm.DateTime" Precision="0" sap:display-format="Date" sap:label="Created On" sap:quickinfo="Date on which the object was created"/>
        <Property Name="LastChangeDateTime" Type="Edm.DateTimeOffset" Precision="7" sap:label="Last Change Date Time"/>
        <NavigationProperty Name="to_BusinessPartnerAddress" Relationship="API_BUSINESS_PARTNER.assoc_BP_Address" FromRole="FromRole_assoc_BP_Address" ToRole="ToRole_assoc_BP_Address"/>
      </EntityType>
      <EntityType Name="A_BusinessPartnerAddressType" sap:label="Business Partner Address" sap:content-version="1">
        <Key><PropertyRef Name="BusinessPartner"/><PropertyRef Name="AddressID"/></Key>
        <Property Name="BusinessPartner" Type="Edm.String" Nullable="false" MaxLength="10" sap:label="Business Partner"/>
        <Property Name="AddressID" Type="Edm.String" Nullable="false" MaxLength="10" sap:label="Address Number"/>
        <Property Name="CityName" Type="Edm.String" MaxLength="40" sap:label="City"/>
        <Property Name="Country" Type="Edm.String" MaxLength="3" sap:label="Country/Region Key" sap:filterable="false"/>
      </EntityType>
      <EntityType Name="A_BPTaxType" sap:label="Tax Number" sap:content-version="1">
        <Key><PropertyRef Name="BusinessPartner"/></Key>
        <Property Name="BusinessPartner" Type="Edm.String" Nullable="false" MaxLength="10"/>
      </EntityType>
      <EntityType Name="A_BPRoleType" sap:content-version="1">
        <Key><PropertyRef Name="BusinessPartner"/><PropertyRef Name="BusinessPartnerRole"/></Key>
        <Property Name="BusinessPartner" Type="Edm.String" Nullable="false" MaxLength="10" sap:required-in-filter="true"/>
        <Property Name="BusinessPartnerRole" Type="Edm.String" Nullable="false" MaxLength="6"/>
        <Property Name="ValidFrom" Type="Edm.DateTimeOffset"/>
        <Property Name="Amount" Type="Edm.Decimal" Precision="16" Scale="3"/>
        <Property Name="Counter" Type="Edm.Int64"/>
        <Property Name="Id" Type="Edm.Guid"/>
      </EntityType>
      <Association Name="assoc_BP_Address" sap:content-version="1">
        <End Type="API_BUSINESS_PARTNER.A_BusinessPartnerType" Multiplicity="1" Role="FromRole_assoc_BP_Address"/>
        <End Type="API_BUSINESS_PARTNER.A_BusinessPartnerAddressType" Multiplicity="*" Role="ToRole_assoc_BP_Address"/>
        <ReferentialConstraint>
          <Principal Role="FromRole_assoc_BP_Address"><PropertyRef Name="BusinessPartner"/></Principal>
          <Dependent Role="ToRole_assoc_BP_Address"><PropertyRef Name="BusinessPartner"/></Dependent>
        </ReferentialConstraint>
      </Association>
      <EntityContainer Name="API_BUSINESS_PARTNER_Entities" m:IsDefaultEntityContainer="true" sap:supported-formats="atom json xlsx">
        <EntitySet Name="A_BusinessPartner" EntityType="API_BUSINESS_PARTNER.A_BusinessPartnerType" sap:creatable="false" sap:content-version="1"/>
        <EntitySet Name="A_BusinessPartnerAddress" EntityType="API_BUSINESS_PARTNER.A_BusinessPartnerAddressType" sap:content-version="1"/>
        <EntitySet Name="A_BPTax" EntityType="API_BUSINESS_PARTNER.A_BPTaxType" sap:addressable="false" sap:content-version="1"/>
        <EntitySet Name="A_BPRole" EntityType="API_BUSINESS_PARTNER.A_BPRoleType" sap:requires-filter="true" sap:content-version="1"/>
        <AssociationSet Name="assoc_BP_Address" Association="API_BUSINESS_PARTNER.assoc_BP_Address" sap:content-version="1">
          <End EntitySet="A_BusinessPartner" Role="FromRole_assoc_BP_Address"/>
          <End EntitySet="A_BusinessPartnerAddress" Role="ToRole_assoc_BP_Address"/>
        </AssociationSet>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`
